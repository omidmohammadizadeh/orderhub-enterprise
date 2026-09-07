/**
 * Score transcription models on REAL phone audio — sizes, addresses,
 * postcodes, yes/no — and time them.
 *
 * Nothing here can be run without audio. There are no recordings in this
 * repository, deliberately; record test calls from the Telnyx media stream
 * (8 kHz μ-law), convert to WAV, and label them in a manifest:
 *
 *   [{ "file": "calls/size-12.wav", "truth": "12", "kind": "size" },
 *    { "file": "calls/pc-1.wav",   "truth": "NE10 8YH", "kind": "postcode" },
 *    { "file": "calls/yes-3.wav",  "truth": "yes", "kind": "yesno" },
 *    { "file": "calls/addr-2.wav", "truth": "11 Follingsby Drive", "kind": "address" }]
 *
 * Run:  OPENAI_API_KEY=… npx ts-node scripts/voice-transcribe-eval.ts manifest.json
 *       [--models gpt-4o-mini-transcribe,gpt-4o-transcribe,whisper-1] [--prompt "menu words…"]
 *
 * The --prompt is the domain vocabulary experiment: shop name, dish names,
 * local street names. Compare accuracy with and without it before deciding
 * anything. Latency is wall-clock per request from this machine, which is
 * NOT the in-call latency (that is measured by the gateway's turn timing).
 */
import { readFileSync } from "fs";
import { basename } from "path";

type Kind = "size" | "address" | "postcode" | "yesno" | "item";
interface Row { file: string; truth: string; kind: Kind }

const args = process.argv.slice(2);
const manifestPath = args.find((a) => !a.startsWith("--"));
if (!manifestPath) { console.error("usage: voice-transcribe-eval.ts manifest.json [--models a,b] [--prompt '…']"); process.exit(2); }
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const models = (flag("--models") ?? "gpt-4o-mini-transcribe,gpt-4o-transcribe,whisper-1").split(",");
const prompt = flag("--prompt");
const key = process.env.OPENAI_API_KEY;
if (!key) { console.error("OPENAI_API_KEY is not set"); process.exit(2); }

const rows: Row[] = JSON.parse(readFileSync(manifestPath, "utf8"));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words: Record<string, string> = { one:"1",two:"2",three:"3",four:"4",five:"5",six:"6",seven:"7",eight:"8",nine:"9",ten:"10",eleven:"11",twelve:"12",fourteen:"14",sixteen:"16",eighteen:"18" };
const digits = (s: string) => norm(s).split(" ").map((w) => words[w] ?? w).join(" ");

/** Did the transcript carry the thing we needed? Judged per kind, not by WER. */
function correct(kind: Kind, truth: string, heard: string): boolean {
  const t = digits(truth), h = digits(heard);
  switch (kind) {
    case "size":     return new RegExp(`\\b${t.replace(/\D/g, "")}\\b`).test(h);
    case "postcode": return h.replace(/\s/g, "").includes(t.replace(/\s/g, ""));
    case "yesno": {
      const yes = /^(yes|yeah|yep|correct|that s right)\b/.test(h), no = /^(no|nope|nah)\b/.test(h);
      return t.startsWith("y") ? yes && !no : no && !yes;
    }
    case "address":  { const tw = t.split(" "); return tw.filter((w) => h.includes(w)).length / tw.length >= 0.75; }
    case "item":     return h.includes(t);
  }
}

async function transcribe(model: string, file: string): Promise<{ text: string; ms: number }> {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(file)]), basename(file));
  form.append("model", model);
  form.append("language", "en");
  if (prompt) form.append("prompt", prompt);
  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`${model} ${res.status}: ${await res.text()}`);
  const body: any = await res.json();
  return { text: String(body.text ?? ""), ms };
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };

(async () => {
  console.log(`models: ${models.join(", ")}   prompt: ${prompt ? `"${prompt.slice(0, 40)}…"` : "none"}   rows: ${rows.length}`);
  for (const model of models) {
    const byKind: Record<string, { ok: number; n: number }> = {};
    const lat: number[] = [];
    const misses: string[] = [];
    for (const r of rows) {
      try {
        const { text, ms } = await transcribe(model, r.file);
        lat.push(ms);
        const ok = correct(r.kind, r.truth, text);
        (byKind[r.kind] ??= { ok: 0, n: 0 }).n += 1;
        if (ok) byKind[r.kind]!.ok += 1; else misses.push(`  ${r.kind.padEnd(8)} want ${JSON.stringify(r.truth)} heard ${JSON.stringify(text)}`);
      } catch (e: any) { misses.push(`  ERROR ${r.file}: ${e?.message ?? e}`); }
    }
    console.log(`\n== ${model} ==  latency p50 ${pct(lat, 50)}ms p95 ${pct(lat, 95)}ms (n=${lat.length})`);
    for (const [k, v] of Object.entries(byKind)) console.log(`  ${k.padEnd(9)} ${v.ok}/${v.n}  ${Math.round((100 * v.ok) / v.n)}%`);
    if (misses.length) console.log("  misses:\n" + misses.join("\n"));
  }
})();
