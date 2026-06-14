# Bluetooth printing

The AS-3 bridge ships a Bluetooth transport stub at
`apps/print-bridge/src/transport/bluetooth.ts`. This document captures
what each vendor needs so AS-3.3 can land the adapters per brand.

## Library

[`@abandonware/noble`](https://github.com/abandonware/noble) — Node BLE
client that works on macOS, Linux, Windows.

`noble` is an `optionalDependency` so the binary still installs on
Linux servers that don't have `libbluetooth-dev`. The agent throws a
clean error if Bluetooth is requested but `noble` failed to install.

## Vendor adapters

| Vendor / model        | Mode       | Service UUID                              | Write characteristic                       | Notes |
|-----------------------|------------|-------------------------------------------|--------------------------------------------|-------|
| Star TSP100 BTi       | BT Classic | `00001101-0000-1000-8000-00805f9b34fb` (SPP) | SPP write                                  | Uses StarPRNT — different ESC/POS dialect |
| Epson TM-P20          | BLE        | `000018f0-0000-1000-8000-00805f9b34fb`    | `00002af1-0000-1000-8000-00805f9b34fb`     | 20-byte MTU chunking |
| Sunmi V2 / V2s        | BLE        | `0000FF00-…`                              | `0000FF02-…`                               | StarPRNT + native print API; SDK preferred |
| XPrinter XP-T58 BT    | BLE        | `000018f0-…`                              | `00002af1-…`                               | Generic ESC/POS |
| Generic ESC/POS BLE   | BLE        | discover via name "BlueTooth Printer"     | first writable char                         | Fallback |

## Pairing

Bluetooth pairing happens at the OS level, **not** through Order Hub.
The operator pairs the printer with macOS/Windows/Linux first, then
adds the MAC to the bridge config:

```json
{
  "transport": "bluetooth",
  "btMac": "00:11:22:33:44:55",
  "paperWidth": 80
}
```

## Why we don't auto-discover

Bluetooth discovery on macOS requires the host app to be foregrounded
(privacy permission). Linux BlueZ scanning needs root. Cross-platform
scan UX is too fragile to ship as a default. The operator pairs once
in OS settings; the bridge just connects to a known MAC.

## Implementation notes (for AS-3.3)

```ts
const noble = require("@abandonware/noble");

await new Promise((res) => noble.once("stateChange", res));
await noble.startScanningAsync([SERVICE_UUID], false);
noble.on("discover", async (p) => {
  if (p.address.toLowerCase() !== btMac.toLowerCase()) return;
  await noble.stopScanningAsync();
  await p.connectAsync();
  const { characteristics } = await p.discoverSomeServicesAndCharacteristicsAsync(
    [SERVICE_UUID], [WRITE_UUID],
  );
  const write = characteristics[0];
  for (let i = 0; i < buf.length; i += 20) {
    await write.writeAsync(buf.subarray(i, i + 20), false);
  }
  await p.disconnectAsync();
});
```

## Throughput

BLE caps at ~512 bytes/sec in practice; a 30-line receipt (~600 bytes)
takes ~1.5s. Fine for one ticket at a time, slow at peak. For a busy
kitchen prefer **LAN** for the kitchen printer and reserve Bluetooth
for delivery driver receipts where latency doesn't matter.
