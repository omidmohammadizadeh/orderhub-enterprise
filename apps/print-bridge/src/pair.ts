// Interactive pairing flow. Prompts the operator for the 6-character
// code shown on the dashboard's "Pair new device" modal, sends the
// device identity to the API, saves the returned token to config.

import * as os from "os";
import * as readline from "readline";
import { ApiClient } from "./net/api-client";
import { loadConfig, saveConfig } from "./config/config";

export async function runPair(deviceName?: string) {
  const cfg = loadConfig();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q: string) =>
    new Promise<string>((resolve) => rl.question(q, resolve));

  console.log("\n— Order Hub Print Bridge — Device pairing —\n");
  console.log(`API:       ${cfg.apiUrl}`);
  console.log(`Device ID: ${cfg.deviceId}`);
  console.log(`Hostname:  ${os.hostname()}`);
  console.log(`OS:        ${os.type()} ${os.release()}\n`);

  const code = (await ask("Pair code (6 chars from dashboard): "))
    .trim()
    .toUpperCase();
  const name =
    deviceName ?? ((await ask(`Device name [${os.hostname()}]: `)) || os.hostname());
  rl.close();

  const api = new ApiClient(cfg);
  const result = await api.pair({
    code,
    deviceId: cfg.deviceId,
    deviceName: name,
    hostname: os.hostname(),
    osType: `${os.type()} ${os.release()}`,
    kind: "WEB_BRIDGE",
    versionString: "0.1.0",
    capabilities: { transports: ["lan", "bluetooth", "usb"] },
  });

  cfg.agentId = result.id;
  cfg.apiToken = result.apiToken;
  cfg.locationId = result.locationId;
  cfg.deviceName = name;
  saveConfig(cfg);

  console.log(`\n✓ Paired as agent ${result.id}`);
  console.log(`✓ Token saved to ~/.orderhub-print-bridge/config.json`);
  console.log(`Next: configure printers in config.json under "printers"[]`);
  console.log("Then run:  orderhub-print-bridge");
}
