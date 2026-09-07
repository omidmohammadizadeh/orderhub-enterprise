/**
 * How loud the caller's line is, without keeping any of it.
 *
 * μ-law (G.711) decoded to 16-bit PCM, RMS over a window, reported in dBFS.
 * Exists for one diagnosis: a caller who spoke and was not heard. Energy
 * arriving on the line while the voice detector reports nothing is that
 * fault, and nothing else in the log can show it. Only numbers leave here.
 */

/** One μ-law byte → 16-bit linear sample. Standard G.711 expansion. */
export function mulawToPcm16(u: number): number {
  const x = ~u & 0xff;
  const sign = x & 0x80;
  const exponent = (x >> 4) & 0x07;
  const mantissa = x & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/** RMS level of a μ-law payload in dBFS (0 = full scale; silence → -Infinity). */
export function mulawRmsDb(payload: Buffer): number {
  if (!payload.length) return -Infinity;
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    const s = mulawToPcm16(payload[i]!) / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / payload.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/**
 * A rolling one-second picture of the inbound line.
 *
 * Frames and peak level per window, and whether the voice detector fired in
 * it. "Loud and undetected" is the line that matters.
 */
export class InboundMeter {
  private frames = 0;
  private peakDb = -Infinity;
  private detected = false;
  private windowStartedAt: number;
  /** Per-call totals, for the summary at hangup. */
  readonly totals = { windows: 0, loudWindows: 0, loudUndetected: 0 };

  constructor(
    private readonly windowMs = 1000,
    /** Above this is "somebody is probably talking". Phone lines idle around -50 to -60 dBFS. */
    private readonly loudDb = -35,
    now = Date.now(),
  ) {
    this.windowStartedAt = now;
  }

  speechDetected(): void {
    this.detected = true;
  }

  /** Feed one frame. Returns a window report when a window has just closed. */
  frame(
    payloadB64: string,
    now = Date.now(),
  ): { frames: number; peakDb: number; detected: boolean; loudUndetected: boolean } | null {
    const db = mulawRmsDb(Buffer.from(payloadB64, 'base64'));
    this.frames += 1;
    if (db > this.peakDb) this.peakDb = db;
    if (now - this.windowStartedAt < this.windowMs) return null;
    const report = {
      frames: this.frames,
      peakDb: this.peakDb,
      detected: this.detected,
      loudUndetected: this.peakDb >= this.loudDb && !this.detected,
    };
    this.totals.windows += 1;
    if (report.peakDb >= this.loudDb) this.totals.loudWindows += 1;
    if (report.loudUndetected) this.totals.loudUndetected += 1;
    this.frames = 0;
    this.peakDb = -Infinity;
    this.detected = false;
    this.windowStartedAt = now;
    return report;
  }
}
