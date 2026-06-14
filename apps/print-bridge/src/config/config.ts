// Local config file. Stored at $HOME/.orderhub-print-bridge/config.json.
// First-run generates a deviceId UUID; subsequent runs reuse it so the
// API can match the install to its existing PrintAgent row.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";

export interface Config {
  apiUrl: string;
  deviceId: string;       // UUID, generated on first boot
  agentId?: string;       // set after successful pair
  apiToken?: string;      // set after successful pair
  locationId?: string;    // set after successful pair
  deviceName?: string;    // human label, set during pairing
  printers: ConfiguredPrinter[];
  logLevel: "debug" | "info" | "warn" | "error";
}

export interface ConfiguredPrinter {
  // Reference to a Printer row on the server. The dashboard binds an
  // OrderHub Printer to this device by setting Printer.agentId.
  printerId: string;
  transport: "lan" | "bluetooth" | "usb";
  // LAN:
  host?: string;
  port?: number;
  // Bluetooth: MAC address.
  btMac?: string;
  // USB: vendor + product id.
  usbVendor?: number;
  usbProduct?: number;
  paperWidth?: 58 | 80;
}

const DEFAULT_API = "https://orderhub-api-0re6.onrender.com/api/v1";

function configDir(): string {
  return path.join(os.homedir(), ".orderhub-print-bridge");
}

function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function loadConfig(): Config {
  const p = configPath();
  if (!fs.existsSync(configDir())) {
    fs.mkdirSync(configDir(), { recursive: true });
  }
  if (!fs.existsSync(p)) {
    const seed: Config = {
      apiUrl: DEFAULT_API,
      deviceId: uuidv4(),
      printers: [],
      logLevel: "info",
    };
    fs.writeFileSync(p, JSON.stringify(seed, null, 2));
    return seed;
  }
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw) as Config;
}

export function saveConfig(cfg: Config): void {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

export function isPaired(cfg: Config): boolean {
  return !!cfg.agentId && !!cfg.apiToken;
}
