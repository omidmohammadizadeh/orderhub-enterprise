// Client-side SMS segment estimator — mirrors the server's WalletService so the
// compose screen shows the same segment count (and therefore cost) the wallet
// will bill. GSM-7 → 160/153 chars per part; anything non-GSM → UCS-2 70/67.

const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€";

export interface SegmentInfo {
  segments: number;
  length: number;
  encoding: "GSM-7" | "Unicode";
  perSegment: number;
  remaining: number; // chars left in the current segment
}

export function estimateSegments(text: string): SegmentInfo {
  const s = text ?? "";
  let isGsm = true;
  let units = 0;
  for (const ch of s) {
    if (GSM7.includes(ch)) units += 1;
    else if (GSM7_EXT.includes(ch)) units += 2;
    else {
      isGsm = false;
      break;
    }
  }

  if (isGsm) {
    const single = 160;
    const multi = 153;
    const segments = units <= single ? Math.max(1, units === 0 ? 1 : 1) : Math.ceil(units / multi);
    const per = segments <= 1 ? single : multi;
    return {
      segments: units <= single ? 1 : Math.ceil(units / multi),
      length: units,
      encoding: "GSM-7",
      perSegment: per,
      remaining: (units <= single ? single : Math.ceil(units / multi) * multi) - units,
    };
  }

  const codeUnits = s.length;
  const single = 70;
  const multi = 67;
  const segments = codeUnits <= single ? 1 : Math.ceil(codeUnits / multi);
  const per = segments <= 1 ? single : multi;
  return {
    segments,
    length: codeUnits,
    encoding: "Unicode",
    perSegment: per,
    remaining: (segments <= 1 ? single : segments * multi) - codeUnits,
  };
}
