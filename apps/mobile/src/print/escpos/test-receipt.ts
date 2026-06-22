// Minimal ESC/POS byte generator — just enough to confirm the BT
// pipeline (tablet → printer) actually works. The full renderer
// (table layouts, QR codes, image logo) gets ported from
// apps/print-bridge/src/renderer in Build B, once we know the
// hardware path is solid.
//
// Output works on Epson TM-m30II, Star TSP100/143, and any generic
// 80mm ESC/POS thermal printer — these commands are the lowest
// common denominator.

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const init = [ESC, 0x40];
const alignCenter = [ESC, 0x61, 0x01];
const alignLeft = [ESC, 0x61, 0x00];
const boldOn = [ESC, 0x45, 0x01];
const boldOff = [ESC, 0x45, 0x00];
const doubleSizeOn = [GS, 0x21, 0x11];
const doubleSizeOff = [GS, 0x21, 0x00];
const cut = [GS, 0x56, 0x42, 0x00]; // partial cut, leaves a tab

function text(s: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
  return bytes;
}

function line(s: string): number[] {
  return [...text(s), LF];
}

// 42 columns at font A on 80mm paper.
function divider(): number[] {
  return line("-".repeat(42));
}

// Builds a self-contained test receipt as a Uint8Array, ready to
// hand to the Bluetooth transport.
export function buildTestReceipt(): Uint8Array {
  const now = new Date();
  const stamp = `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;

  const bytes: number[] = [
    ...init,
    ...alignCenter,
    ...doubleSizeOn,
    ...boldOn,
    ...line("ORDER HUB"),
    ...doubleSizeOff,
    ...line("SOLUTIONS"),
    ...boldOff,
    LF,
    ...line("TEST RECEIPT"),
    ...line(stamp),
    LF,
    ...alignLeft,
    ...divider(),
    ...line("Tablet  : Connected via Bluetooth"),
    ...line("Printer : ESC/POS responding"),
    ...line("Status  : OK"),
    ...divider(),
    LF,
    ...alignCenter,
    ...line("If you can read this, native"),
    ...line("Bluetooth printing works."),
    LF,
    LF,
    LF,
    ...cut,
  ];

  return new Uint8Array(bytes);
}
