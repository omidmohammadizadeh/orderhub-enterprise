// The two emails a walk-in loyalty member gets: their card (on joining, or
// re-sent from the till) and the 6-digit code that opens it on a new phone.
//
// Table layout and inline styles only — that is what every mail client
// renders. The card colour is the shop's, so the email looks like the pass.

import { foregroundFor, safeColor } from "./pass-art";

function esc(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function frame(opts: { title: string; color: string; logoUrl: string | null; body: string }): string {
  const bg = safeColor(opts.color);
  const fg = foregroundFor(bg);
  const logo = opts.logoUrl
    ? `<img src="${esc(opts.logoUrl)}" width="40" height="40" alt="" style="display:block;border-radius:8px;background:#fff;object-fit:contain" />`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="background:${bg};color:${fg};padding:20px 24px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
${logo ? `<td style="padding-right:12px">${logo}</td>` : ""}
<td style="font-size:18px;font-weight:700;color:${fg}">${esc(opts.title)}</td>
</tr></table></td></tr>
<tr><td style="padding:28px 24px;color:#18181b;font-size:15px;line-height:1.55">${opts.body}</td></tr>
<tr><td style="padding:0 24px 24px;color:#a1a1aa;font-size:12px;line-height:1.5">You're getting this because this email address was used for the ${esc(opts.title)} loyalty card.</td></tr>
</table></td></tr></table></body></html>`;
}

function button(href: string, label: string, color: string): string {
  const bg = safeColor(color);
  const fg = foregroundFor(bg);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0"><tr><td style="border-radius:12px;background:${bg}">
<a href="${esc(href)}" style="display:inline-block;padding:14px 22px;font-size:16px;font-weight:600;color:${fg};text-decoration:none">${esc(label)}</a>
</td></tr></table>`;
}

export function cardEmail(opts: {
  kind: "welcome" | "resend";
  title: string;
  color: string;
  logoUrl: string | null;
  firstName: string | null;
  cardUrl: string;
  stampsRequired: number;
  rewardLabel: string;
  earnRule: string;
}): { subject: string; html: string; text: string } {
  const hello = opts.firstName ? `Hi ${esc(opts.firstName)},` : "Hi,";
  const intro =
    opts.kind === "welcome"
      ? `Welcome to the <strong>${esc(opts.title)}</strong> loyalty card. Collect ${opts.stampsRequired} stamps and get <strong>${esc(opts.rewardLabel.toLowerCase())}</strong>.`
      : `Here's your <strong>${esc(opts.title)}</strong> loyalty card.`;
  const body = `<p style="margin:0 0 12px">${hello}</p>
<p style="margin:0 0 12px">${intro}</p>
<p style="margin:0">Open your card and tap <strong>Add to Apple Wallet</strong> or <strong>Add to Google Wallet</strong>. Show it at the till each time you order.</p>
${button(opts.cardUrl, "Open my loyalty card", opts.color)}
<p style="margin:0;color:#52525b;font-size:13px">${esc(opts.earnRule)}</p>`;
  return {
    subject: opts.kind === "welcome" ? `Your ${opts.title} loyalty card` : `Your ${opts.title} loyalty card link`,
    html: frame({ title: opts.title, color: opts.color, logoUrl: opts.logoUrl, body }),
    text: `${opts.firstName ? `Hi ${opts.firstName},` : "Hi,"}\n\nYour ${opts.title} loyalty card: ${opts.cardUrl}\n\nOpen it and add it to Apple Wallet or Google Wallet.\n${opts.earnRule}`,
  };
}

export function codeEmail(opts: {
  title: string;
  color: string;
  logoUrl: string | null;
  firstName: string | null;
  code: string;
  cardUrl: string;
}): { subject: string; html: string; text: string } {
  const hello = opts.firstName ? `Hi ${esc(opts.firstName)},` : "Hi,";
  const body = `<p style="margin:0 0 12px">${hello}</p>
<p style="margin:0 0 4px">Enter this code to open your ${esc(opts.title)} loyalty card on your phone:</p>
<p style="margin:18px 0;font-size:34px;font-weight:700;letter-spacing:8px;font-family:Menlo,Consolas,monospace;color:#18181b">${esc(opts.code)}</p>
<p style="margin:0;color:#52525b;font-size:13px">It works for 10 minutes. Or skip the code and open your card straight away:</p>
${button(opts.cardUrl, "Open my loyalty card", opts.color)}
<p style="margin:0;color:#71717a;font-size:13px">Didn't ask for this? You can ignore this email — nothing changes on your card.</p>`;
  return {
    subject: `${opts.code} is your ${opts.title} loyalty card code`,
    html: frame({ title: opts.title, color: opts.color, logoUrl: opts.logoUrl, body }),
    text: `Your ${opts.title} loyalty card code is ${opts.code} (valid 10 minutes).\n\nOr open your card: ${opts.cardUrl}`,
  };
}
