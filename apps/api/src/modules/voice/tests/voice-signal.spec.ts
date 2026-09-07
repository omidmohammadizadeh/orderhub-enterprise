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
    const m = new InboundMeter(1000, -35, 0);
    for (let i = 0; i < 49; i++) expect(m.frame(tone(6000), i * 20)).toBeNull();
    const r = m.frame(tone(6000), 1000)!;
    expect(r.frames).toBe(50);
    expect(r.peakDb).toBeGreaterThan(-35);
    expect(r.loudUndetected).toBe(true);
    expect(m.totals.loudUndetected).toBe(1);
  });

  it('does not flag a loud window the detector did fire in, nor a quiet one', () => {
    const m = new InboundMeter(1000, -35, 0);
    m.speechDetected();
    for (let i = 0; i < 49; i++) m.frame(tone(6000), i * 20);
    expect(m.frame(tone(6000), 1000)!.loudUndetected).toBe(false);
    for (let i = 0; i < 49; i++) m.frame(silence(), 1000 + i * 20);
    const quiet = m.frame(silence(), 2000)!;
    expect(quiet.loudUndetected).toBe(false);
    expect(m.totals.loudWindows).toBe(1);
  });
});
