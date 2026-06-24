// LAN (Ethernet/Wi-Fi) transport for ESC/POS receipt printers.
//
// Network thermal printers (Epson TM-m30 LAN, Star, most "kitchen
// printers") listen on raw TCP port 9100 and accept a stream of ESC/POS
// bytes — no protocol, just write the bytes. The tablet is on the same
// Wi-Fi/LAN as the printer, so we open a TCP socket straight to its IP.
//
// Mirrors the Bluetooth transport's contract: connect, write, wait for
// the printer to drain, then close. Throws on any failure so the caller
// can surface a clear error.

import TcpSocket from "react-native-tcp-socket";

const DEFAULT_PORT = 9100;

// Let the printer physically drain before we tear the socket down —
// closing the instant write() returns can truncate the receipt, same as
// the Bluetooth path. Scales with payload size.
const DRAIN_BASE_MS = 300;
const DRAIN_PER_KB_MS = 120;
const DRAIN_MAX_MS = 4000;
const CONNECT_TIMEOUT_MS = 8000;

function drainMsFor(byteLen: number): number {
  return Math.min(
    DRAIN_MAX_MS,
    Math.round(DRAIN_BASE_MS + (byteLen / 1024) * DRAIN_PER_KB_MS),
  );
}

export async function sendBytesOverTcp(
  host: string,
  port: number | undefined,
  bytes: Uint8Array,
): Promise<void> {
  if (!host) throw new Error("No printer IP address");
  if (bytes.length === 0) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      try {
        client.destroy();
      } catch {
        // already closed — ignore
      }
      err ? reject(err) : resolve();
    };

    const client = TcpSocket.createConnection(
      { host, port: port || DEFAULT_PORT },
      () => {
        try {
          // react-native-tcp-socket accepts a Uint8Array directly and
          // base64-encodes it across the native bridge for us.
          client.write(bytes as any);
          // Give the printer time to print, then close.
          setTimeout(() => finish(), drainMsFor(bytes.length));
        } catch (e: any) {
          finish(e instanceof Error ? e : new Error(String(e)));
        }
      },
    );

    client.on("error", (e: any) =>
      finish(e instanceof Error ? e : new Error(String(e?.message ?? e))),
    );

    connectTimer = setTimeout(
      () =>
        finish(
          new Error(
            `Could not reach printer at ${host}:${port || DEFAULT_PORT} — check it's on and on the same network.`,
          ),
        ),
      CONNECT_TIMEOUT_MS,
    );
  });
}
