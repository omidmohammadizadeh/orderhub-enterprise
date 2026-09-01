#!/usr/bin/env node
//
// Order Hub Print Bridge — main entrypoint.
//
// Usage:
//   orderhub-print-bridge            → run agent (must be paired)
//   orderhub-print-bridge pair       → interactive pairing
//   orderhub-print-bridge printers   → list printers at this agent's location
//   orderhub-print-bridge bind <id>  → bind a printer to this agent + save it
//                                       to local config (host/port prompted)
//   orderhub-print-bridge config     → print config path
//   orderhub-print-bridge test-print → render a sample receipt to stdout

import * as readline from "readline";
import { loadConfig, saveConfig, isPaired } from "./config/config";
import { runPair } from "./pair";
import { Agent } from "./agent";
import { ApiClient } from "./net/api-client";
import { renderToEscPos } from "./renderer/escpos-renderer";

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const cmd = process.argv[2] ?? "run";

  if (cmd === "pair") {
    await runPair(process.argv[3]);
    return;
  }
  if (cmd === "config") {
    console.log(JSON.stringify(loadConfig(), null, 2));
    return;
  }
  if (cmd === "printers" || cmd === "list-printers") {
    const cfg = loadConfig();
    if (!isPaired(cfg)) {
      console.error("Not paired. Run `pair` first.");
      process.exit(1);
    }
    const api = new ApiClient(cfg);
    const printers = await api.listLocationPrinters();
    if (printers.length === 0) {
      console.log("No printers at this location yet.");
      return;
    }
    console.log("\nPrinters at this location:\n");
    for (const p of printers) {
      const bound =
        p.agentId === cfg.agentId
          ? " (bound to THIS agent)"
          : p.agentId
            ? ` (bound to agent ${p.agentId})`
            : " (unbound)";
      const addr = p.ipAddress ? `${p.ipAddress}:${p.port ?? 9100}` : "no IP";
      console.log(`  ${p.id}  ${p.name} — ${p.connectionType} ${addr}${bound}`);
    }
    console.log("\nTo bind one of these to THIS agent:");
    console.log("  node dist/main.js bind <id>\n");
    return;
  }
  if (cmd === "bind") {
    const printerId = process.argv[3];
    if (!printerId) {
      console.error("Usage: bind <printerId>  (run `printers` to see IDs)");
      process.exit(1);
    }
    const cfg = loadConfig();
    if (!isPaired(cfg)) {
      console.error("Not paired. Run `pair` first.");
      process.exit(1);
    }
    const api = new ApiClient(cfg);

    // Pull the latest printer info so we can default host/port from the
    // server-side record instead of asking the operator to retype it.
    const all = await api.listLocationPrinters();
    const remote = all.find((p) => p.id === printerId);
    if (!remote) {
      console.error(`No printer ${printerId} at this agent's location.`);
      process.exit(1);
    }

    await api.bindPrinter(printerId);
    console.log(`✓ Server: printer ${remote.name} now routes to this agent.`);

    // Save the matching local entry so the bridge knows where to send
    // bytes for jobs claimed under this printerId.
    //
    // The transport comes from the SERVER's connectionType. This used to be
    // hardcoded to "lan", so binding a Bluetooth or USB printer wrote a LAN
    // entry and then asked for an IP address that does not exist — the
    // operator's only way out was to hand-edit config.json. Whatever the
    // dashboard says the printer is, is what gets written here.
    const paperWidth = remote.paperWidth === 58 ? 58 : 80;
    const next = cfg.printers.filter((p) => p.printerId !== printerId);

    if (remote.connectionType === "USB") {
      // Addressed by vendor + product, the way LAN is addressed by host +
      // port. Set them in the dashboard; only ask if the record is bare.
      const vendor =
        remote.usbVendor ??
        parseInt((await ask("USB vendor id (decimal): ")).trim(), 10);
      const product =
        remote.usbProduct ??
        parseInt((await ask("USB product id (decimal): ")).trim(), 10);
      if (!Number.isFinite(vendor) || !Number.isFinite(product)) {
        console.log("✗ USB printers need both a vendor and a product id.");
        return;
      }
      next.push({
        printerId,
        transport: "usb",
        usbVendor: vendor,
        usbProduct: product,
        paperWidth,
      });
      cfg.printers = next;
      saveConfig(cfg);
      console.log(
        `✓ Local: saved USB ${vendor}/${product} for ${remote.name}.`,
      );
    } else if (remote.connectionType === "BLUETOOTH") {
      const btMac = (await ask("Printer Bluetooth MAC: ")).trim();
      if (!btMac) {
        console.log("✗ Bluetooth printers need a MAC address.");
        return;
      }
      next.push({ printerId, transport: "bluetooth", btMac, paperWidth });
      cfg.printers = next;
      saveConfig(cfg);
      console.log(`✓ Local: saved Bluetooth ${btMac} for ${remote.name}.`);
    } else {
      // Reuse whatever the operator typed in the dashboard for IP/port; only
      // prompt if the server record is missing them.
      const host = remote.ipAddress ?? (await ask("Printer IP: ")).trim();
      const portStr = remote.port
        ? String(remote.port)
        : (await ask("Printer port [9100]: ")).trim() || "9100";
      const port = parseInt(portStr, 10);
      next.push({ printerId, transport: "lan", host, port, paperWidth });
      cfg.printers = next;
      saveConfig(cfg);
      console.log(`✓ Local: saved ${host}:${port} for ${remote.name}.`);
    }
    console.log("\nNow run:  node dist/main.js");
    return;
  }
  if (cmd === "test-print") {
    const buf = renderToEscPos(
      {
        kind: "TEST_PRINT",
        printerName: "stdout",
        locationName: "Local test",
        datetime: new Date().toISOString(),
        message: "Bridge is alive.",
        qrCode: "https://orderhubsolutions.com",
        openCashDrawer: false,
        paperWidth: 80,
      },
      { paperWidth: 80 },
    );
    process.stdout.write(buf);
    return;
  }

  const cfg = loadConfig();
  if (!isPaired(cfg)) {
    console.error(
      "Not paired. Run `orderhub-print-bridge pair` first (see PRINT_AGENT_INSTALL.md).",
    );
    process.exit(1);
  }
  await new Agent(cfg).run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
