import { InboundMeter, mulawRmsDb, mulawToPcm16 } from '../voice-signal';

// μ-law encode, for building test frames only.
const pcmToMulaw = (s: number): number => {
  const BIAS = 0x84,
    CLIP = 32635;
  let sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
};
const tone = (amplitude: number, n = 160) =>
  Buffer.from(
    Array.from({ length: n }, (_, i) => pcmToMulaw(Math.round(amplitude * Math.sin(i / 3)))),
  ).toString('base64');
const silence = (n = 160) =>
  Buffer.from(Array.from({ length: n }, () => pcmToMulaw(0))).toString('base64');

describe('the inbound meter', () => {
  it('decodes μ-law round-trip within codec error', () => {
    for (const v of [0, 100, -100, 1000, -8000, 30000]) {
      const back = mulawToPcm16(pcmToMulaw(v));
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.max(8, Math.abs(v) * 0.07));
    }
  });

  it('calls silence silent and a voice loud', () => {
    expect(mulawRmsDb(Buffer.from(silence(), 'base64'))).toBeLessThan(-60);
    expect(mulawRmsDb(Buffer.from(tone(8000), 'base64'))).toBeGreaterThan(-20);
  });

  it('flags a loud window with no detection — the deaf-line signature', () => {
    const m = new InboundMeter(1000, 12, -30, 5000, 0);
    for (let i = 0; i < 49; i++) expect(m.frame(tone(6000), i * 20)).toBeNull();
    const r = m.frame(tone(6000), 1000)!;
    expect(r.frames).toBe(50);
    expect(r.peakDb).toBeGreaterThan(-20); // judged absolutely: no floor is known yet
    expect(r.loudUndetected).toBe(true);
    expect(m.totals.loudUndetected).toBe(1);
  });

  it('does not flag a loud window the detector did fire in, nor a quiet one', () => {
    const m = new InboundMeter(1000, 12, -30, 5000, 0);
    m.speechDetected();
    for (let i = 0; i < 49; i++) m.frame(tone(6000), i * 20);
    expect(m.frame(tone(6000), 1000)!.loudUndetected).toBe(false);
    for (let i = 0; i < 49; i++) m.frame(silence(), 1000 + i * 20);
    const quiet = m.frame(silence(), 2000)!;
    expect(quiet.loudUndetected).toBe(false);
    expect(m.totals.loudWindows).toBe(1);
  });
});

// ── call 9-LMxBjQ: 152 of 162 seconds "loud but undetected" on a -33 dBFS line
describe('a meter that knows its own floor', () => {
  const pcmToMulaw = (s: number): number => {
    const BIAS = 0x84,
      CLIP = 32635;
    let sign = (s >> 8) & 0x80;
    if (sign) s = -s;
    if (s > CLIP) s = CLIP;
    s += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
    return ~(sign | (exponent << 4) | ((s >> (exponent + 3)) & 0x0f)) & 0xff;
  };
  const level = (amplitude: number) =>
    Buffer.from(
      Array.from({ length: 160 }, (_, i) => pcmToMulaw(Math.round(amplitude * Math.sin(i / 3)))),
    ).toString('base64');
  const NOISE = level(700); // ≈ -33 dBFS, what that line idled at
  const VOICE = level(16000); // ≈ -6 dBFS, what "cash" looks like

  const second = (
    m: InboundMeter,
    payload: string,
    t0: number,
    opts: { playing?: boolean } = {},
  ) => {
    let r = null;
    for (let i = 0; i <= 50; i++) r = m.frame(payload, t0 + i * 20, opts.playing) ?? r;
    return r!;
  };

  it("does not call the line's own background loud", () => {
    const m = new InboundMeter(1000, 12, -30, 5000, 0);
    const reports = [0, 1, 2, 3, 4, 5].map((s) => second(m, NOISE, s * 1000));
    expect(reports.every((r) => !r.loudUndetected)).toBe(true);
    expect(m.floorDb()).toBeGreaterThan(-40);
    expect(m.floorDb()).toBeLessThan(-25);
  });

  it('flags a voice-loud second above that floor with no detection — once — and not while we are playing', () => {
    const m = new InboundMeter(1000, 12, -30, 5000, 0);
    for (let s = 0; s < 5; s++) second(m, NOISE, s * 1000);
    const burst = second(m, VOICE, 5000);
    expect(burst.loudUndetected).toBe(true);
    expect(m.shouldWarn(6000)).toBe(true);
    expect(m.shouldWarn(7000)).toBe(false); // rate-limited
    const echo = second(m, VOICE, 6000, { playing: true });
    expect(echo.loudUndetected).toBe(false); // our own audio coming back
  });

  it('counts speech as detected from start to stop, across windows', () => {
    const m = new InboundMeter(1000, 12, -30, 5000, 0);
    for (let s = 0; s < 5; s++) second(m, NOISE, s * 1000);
    m.speechDetected();
    const w1 = second(m, VOICE, 5000);
    const w2 = second(m, VOICE, 6000); // still talking, no new speech_started
    m.speechEnded();
    const w3 = second(m, VOICE, 7000); // talking after stop → undetected again
    expect(w1.loudUndetected).toBe(false);
    expect(w2.loudUndetected).toBe(false);
    expect(w3.loudUndetected).toBe(true);
  });
});
