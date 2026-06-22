// Print agent loop for the mobile app.
//
// Lifecycle (after the user has pasted a pair code):
//   1. Persist agentId + apiToken in expo-secure-store
//   2. Every 15s send a heartbeat → dashboard's Agents tab shows "Online"
//   3. Every 5s list bound printers + claim jobs
//   4. For each job: render ESC/POS → send via BT → POST /complete or /fail
//
// Singleton. The PosWebView mounts and calls start(); it's safe to call
// start() multiple times — internal `running` flag prevents duplicate
// timers when React re-renders the WebView.

import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import {
  type ApiPrinter,
  type PrintAgentCreds,
  claimJobs,
  clearAgentCreds,
  completeJob,
  failJob,
  heartbeat,
  listMyPrinters,
  loadAgentCreds,
  pair,
  saveAgentCreds,
} from "./api";
import { sendViaBluetooth } from "./transport/bluetooth";
import { buildTestReceipt } from "./escpos/test-receipt";

const HEARTBEAT_MS = 15_000;
const POLL_MS = 5_000;
const VERSION = "mobile-0.1.0";

type StatusListener = (s: AgentStatus) => void;

export interface AgentStatus {
  paired: boolean;
  online: boolean;
  agentId: string | null;
  locationId: string | null;
  printers: ApiPrinter[];
  lastError: string | null;
  lastHeartbeatAt: number | null;
  lastClaimAt: number | null;
}

const initial: AgentStatus = {
  paired: false,
  online: false,
  agentId: null,
  locationId: null,
  printers: [],
  lastError: null,
  lastHeartbeatAt: null,
  lastClaimAt: null,
};

class PrintAgentRuntime {
  private creds: PrintAgentCreds | null = null;
  private status: AgentStatus = { ...initial };
  private listeners = new Set<StatusListener>();
  private hbTimer: any = null;
  private pollTimer: any = null;
  private running = false;
  private printers: ApiPrinter[] = [];

  subscribe(fn: StatusListener): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  private emit() {
    for (const fn of this.listeners) fn(this.status);
  }

  private patch(p: Partial<AgentStatus>) {
    this.status = { ...this.status, ...p };
    this.emit();
  }

  // Called from App / PosWebView on mount. Loads creds from secure-store
  // if present, otherwise stays in the "unpaired" state until the user
  // submits a pair code.
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const saved = await loadAgentCreds();
    if (!saved) {
      this.patch({ paired: false, online: false });
      return;
    }
    this.creds = saved;
    this.patch({
      paired: true,
      agentId: saved.agentId,
      locationId: saved.locationId,
    });
    await this.heartbeatOnce();
    await this.pollOnce();
    this.hbTimer = setInterval(() => this.heartbeatOnce(), HEARTBEAT_MS);
    this.pollTimer = setInterval(() => this.pollOnce(), POLL_MS);
  }

  // After the user pastes the pair code into PrinterSetupScreen.
  async pairWithCode(code: string): Promise<void> {
    const deviceName = `Tablet (${Platform.OS})`;
    const deviceId = await getOrCreateDeviceId();
    const c = await pair(code, deviceName, deviceId);
    await saveAgentCreds(c);
    this.creds = c;
    this.patch({
      paired: true,
      agentId: c.agentId,
      locationId: c.locationId,
      lastError: null,
    });
    // Kick the loops immediately so the dashboard flips to Online within
    // a couple of seconds rather than the next 15s tick.
    await this.heartbeatOnce();
    await this.pollOnce();
    if (!this.hbTimer) {
      this.hbTimer = setInterval(() => this.heartbeatOnce(), HEARTBEAT_MS);
    }
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.pollOnce(), POLL_MS);
    }
  }

  async unpair(): Promise<void> {
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.hbTimer = null;
    this.pollTimer = null;
    this.creds = null;
    this.printers = [];
    await clearAgentCreds();
    this.status = { ...initial };
    this.emit();
  }

  private async heartbeatOnce(): Promise<void> {
    if (!this.creds) return;
    try {
      const ok = await heartbeat(this.creds, {
        versionString: VERSION,
        osType: Platform.OS === "android" ? "Android" : Platform.OS,
        hostname: `orderhub-mobile-${Platform.OS}`,
        printerCount: this.printers.length,
        printerStatuses: this.printers.map((p) => ({
          printerId: p.id,
          isOnline: true,
        })),
      });
      this.patch({
        online: ok,
        lastHeartbeatAt: Date.now(),
        lastError: ok ? null : "Heartbeat rejected",
      });
    } catch (err: any) {
      this.patch({ online: false, lastError: err?.message ?? "heartbeat error" });
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.creds) return;
    try {
      const all = await listMyPrinters(this.creds);
      this.printers = all.filter((p) => p.agentId === this.creds!.agentId);
      this.patch({ printers: this.printers, lastClaimAt: Date.now() });
      const printerIds = this.printers.map((p) => p.id);
      const jobs = await claimJobs(this.creds, printerIds);
      for (const job of jobs) {
        await this.runJob(job);
      }
    } catch (err: any) {
      this.patch({ lastError: err?.message ?? "poll error" });
    }
  }

  private async runJob(job: {
    id: string;
    printerId: string | null;
    payload: any;
    copies: number;
  }): Promise<void> {
    if (!this.creds) return;
    const printer = this.printers.find((p) => p.id === job.printerId);
    if (!printer) {
      await failJob(
        this.creds,
        job.id,
        "no_printer",
        "Printer not bound to this agent",
        false,
      );
      return;
    }
    try {
      // For v1 the renderer for real orders lives in the dashboard; the
      // payload comes through as plain text or pre-rendered HTML. We
      // bridge the simplest case here: use the test-receipt renderer
      // as a placeholder until the structured-order renderer lands.
      const lines: string[] = [
        ...(job.payload?.headerLines ?? []),
        ...(job.payload?.lines ?? []),
        ...(job.payload?.footerLines ?? []),
      ];
      const bytes =
        lines.length > 0
          ? this.renderLines(lines, printer.paperWidth)
          : buildTestReceipt(printer.paperWidth as 58 | 80);
      const copies = Math.max(1, job.copies ?? 1);
      for (let i = 0; i < copies; i++) {
        if (
          printer.connectionType === "BLUETOOTH" ||
          printer.connectionType === "BT"
        ) {
          if (!printer.btMac) {
            throw new Error("Bluetooth printer missing MAC address");
          }
          await sendViaBluetooth(printer.btMac, bytes);
        } else {
          throw new Error(
            `Transport ${printer.connectionType} not yet supported on mobile`,
          );
        }
      }
      await completeJob(this.creds, job.id);
    } catch (err: any) {
      await failJob(
        this.creds,
        job.id,
        "send_failed",
        err?.message ?? String(err),
        true,
      );
    }
  }

  // Tiny ESC/POS line renderer used when the payload is plain text.
  // Real receipts will use the structured-order renderer once ported
  // from print-bridge; this is the bridge of last resort so payloads
  // that aren't structured don't get dropped silently.
  private renderLines(lines: string[], paperWidth: number): Uint8Array {
    const cols = paperWidth === 58 ? 32 : 42;
    const bytes: number[] = [0x1b, 0x40]; // init
    for (const l of lines) {
      const s = String(l).slice(0, cols * 4); // soft cap
      const buf = stringToBytes(s);
      for (const b of buf) bytes.push(b);
      bytes.push(0x0a);
    }
    bytes.push(0x0a, 0x0a, 0x0a); // feed
    bytes.push(0x1d, 0x56, 0x42, 0x00); // cut
    return new Uint8Array(bytes);
  }
}

// Stable device ID kept in secure-store. Survives uninstall? No — secure
// store gets wiped. That's fine: a new device ID = the dashboard sees a
// new agent and you pair fresh. Pair codes are cheap.
const DEVICE_ID_KEY = "orderhub.deviceId.v1";
async function getOrCreateDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = `mobile-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
  return id;
}

function stringToBytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else out.push(0x3f); // '?' for non-ASCII placeholder
  }
  return out;
}

export const printAgent = new PrintAgentRuntime();
