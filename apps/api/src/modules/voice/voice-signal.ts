/**
 * How loud the caller's line is, without keeping any of it.
 *
 * μ-law (G.711) decoded to 16-bit PCM, RMS over a window, reported in dBFS.
 * Exists for one diagnosis: a caller who spoke and was not heard. Energy
 * well above the line's own floor, while the voice detector reports nothing,
 * is the trace of that fault — and only the trace: evidence to look at, not
 * proof. Only numbers leave here.
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

export interface WindowReport {
  frames: number;
  peakDb: number;
  /** The detector was active at any point in this window. */
  detected: boolean;
  /** Well above this line's own floor, undetected throughout, and not our own audio. */
  loudUndetected: boolean;
}

/**
 * A rolling one-second picture of the inbound line.
 *
 * The first version called anything above -35 dBFS "loud" and flagged 152 of
 * 162 seconds on a line whose floor sat at -33. Loud is now RELATIVE to the
 * floor this call actually has — a low percentile of the peaks seen so far —
 * and speech counts as detected from speech_started until speech_stopped,
 * not only in the window the start fell in. Warnings are rate-limited, and
 * windows in which the line is playing our own audio are never flagged: the
 * caller's handset echoes it back.
 */
export class InboundMeter {
  private frames = 0;
  private peakDb = -Infinity;
  private detectedInWindow = false;
  private speaking = false;
  private playedInWindow = false;
  private windowStartedAt: number;
  private lastWarnAt = -Infinity;
  private readonly peaks: number[] = [];
  readonly totals = { windows: 0, loudWindows: 0, loudUndetected: 0 };

  constructor(
    private readonly windowMs = 1000,
    /** Loud means this far above the floor… */
    private readonly aboveFloorDb = 12,
    /** …and at least this loud in absolute terms, so a dead-quiet line cannot be "loud" at -70. */
    private readonly absoluteDb = -30,
    /** One warning this often, at most. */
    private readonly warnEveryMs = 5000,
    now = Date.now(),
  ) {
    this.windowStartedAt = now;
  }

  speechDetected(): void {
    this.speaking = true;
    this.detectedInWindow = true;
  }

  speechEnded(): void {
    this.speaking = false;
  }

  /** The line's own background: the 20th percentile of window peaks so far. */
  floorDb(): number {
    if (this.peaks.length < 3) return -Infinity;
    const s = [...this.peaks].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.2)]!;
  }

  shouldWarn(now = Date.now()): boolean {
    if (now - this.lastWarnAt < this.warnEveryMs) return false;
    this.lastWarnAt = now;
    return true;
  }

  /** Feed one frame. Returns a report when a window has just closed. */
  frame(payloadB64: string, now = Date.now(), playing = false): WindowReport | null {
    const db = mulawRmsDb(Buffer.from(payloadB64, 'base64'));
    this.frames += 1;
    if (db > this.peakDb) this.peakDb = db;
    if (this.speaking) this.detectedInWindow = true;
    if (playing) this.playedInWindow = true;
    if (now - this.windowStartedAt < this.windowMs) return null;

    const floor = this.floorDb();
    const loud =
      Number.isFinite(this.peakDb) &&
      this.peakDb >= this.absoluteDb &&
      (floor === -Infinity
        ? this.peakDb >= this.absoluteDb + 10
        : this.peakDb >= floor + this.aboveFloorDb);
    const report: WindowReport = {
      frames: this.frames,
      peakDb: this.peakDb,
      detected: this.detectedInWindow,
      loudUndetected: loud && !this.detectedInWindow && !this.playedInWindow,
    };
    if (Number.isFinite(this.peakDb)) this.peaks.push(this.peakDb);
    this.totals.windows += 1;
    if (loud) this.totals.loudWindows += 1;
    if (report.loudUndetected) this.totals.loudUndetected += 1;
    this.frames = 0;
    this.peakDb = -Infinity;
    // Not carried over. Detection is marked per frame while speech is on,
    // so a window gets it only if speech actually reached into it — the
    // window after speech_stopped must not inherit a detection it never had.
    this.detectedInWindow = false;
    this.playedInWindow = false;
    this.windowStartedAt = now;
    return report;
  }
}
