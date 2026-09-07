/**
 * What number would a transfer actually dial, for one location? READ-ONLY.
 *
 * The live log said:  Telnyx transfer failed 403 … "Destination Number is
 * invalid D11". That does NOT mean the stored number is "D11" — Telnyx appends
 * a diagnostic tag to 403s ("… Invalid D35", "… whitelisted countries D13"),
 * and transfer() only issues the command after toE164() has accepted the
 * number, which it logged nothing about. So the number was well-formed and
 * Telnyx still refused it. The remaining candidates are account-side:
 * outbound voice profile / connection permissions for the destination, or a
 * destination Telnyx will not route (e.g. a non-geographic or premium UK
 * range). This prints exactly what would be sent, masked, so that can be
 * checked against the Telnyx portal without guessing.
 *
 * Run:  DATABASE_URL=… npx ts-node scripts/voice-transfer-check.ts "<location name or id>"
 */
import { PrismaClient } from "@orderhub/database";
import { toE164 } from "../src/modules/sms/phone";

const mask = (n: string | null | undefined) =>
  !n ? "(none)" : n.length <= 4 ? "****" : `${n.slice(0, 3)}${"*".repeat(Math.max(0, n.length - 6))}${n.slice(-3)}`;

(async () => {
  const q = process.argv[2];
  if (!q) { console.error("usage: voice-transfer-check.ts <location name or id>"); process.exit(2); }
  const db = new PrismaClient();
  const loc = await db.location.findFirst({
    where: { OR: [{ id: q }, { name: { contains: q, mode: "insensitive" } }] },
    select: { id: true, name: true, phone: true, settings: true },
  });
  await db.$disconnect();
  if (!loc) { console.error(`no location matching ${JSON.stringify(q)}`); process.exit(1); }
  const settings = (loc.settings ?? {}) as any;
  const configured: string | null = settings.voiceTransferNumber ?? null;
  const fallback: string | null = loc.phone ?? null;
  const chosen = configured ?? fallback;
  const e164 = toE164(chosen);
  console.log(`location            ${loc.name} (${loc.id})`);
  console.log(`voiceTransferNumber ${mask(configured)}   ${configured ? "(used)" : "(not set — falls back to location.phone)"}`);
  console.log(`location.phone      ${mask(fallback)}`);
  console.log(`would dial          ${mask(e164)}   ${e164 ? "← passes toE164; this is what Telnyx rejected" : "← FAILS toE164; transfer() would refuse before calling Telnyx"}`);
  console.log(`raw looks like      ${chosen ? (/^\+?\d[\d\s()-]{6,}$/.test(chosen) ? "a phone number" : `NOT a phone number: ${JSON.stringify(chosen)}`) : "(nothing)"}`);
  console.log(`\nNext: in the Telnyx portal check the Outbound Voice Profile attached to the Call Control connection allows this destination, and try the same number with a manual Call Control dial.`);
})();
