#!/usr/bin/env node
//
// Order Hub Print Bridge — main entrypoint.
//
// Usage:
//   orderhub-print-bridge            → run agent (must be paired)
//   orderhub-print-bridge pair       → interactive pairing
//   orderhub-print-bridge config     → print config path
//   orderhub-print-bridge test-print → render a sample receipt to stdout

import { loadConfig, isPaired } from "./config/config";
import { runPair } from "./pair";
import { Agent } from "./agent";
import { renderToEscPos } from "./renderer/escpos-renderer";

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
