// Email marketing — the block model, the renderer and the starter templates.
//
// Lives in @orderhub/shared because BOTH sides render it: the dashboard draws
// the live preview with it and the API renders the real send with it. One
// function means the preview cannot drift from what lands in the inbox.
//
// The output is deliberately old-fashioned HTML: a 600px table, inline styles,
// buttons as table cells. Outlook still renders with Word's engine and Gmail
// strips most <style>; anything cleverer looks fine in a browser preview and
// breaks in the inbox the restaurant actually cares about.

export type EmailBlock =
  | { id: string; type: "header"; showName?: boolean }
  | { id: string; type: "hero"; imageUrl: string; alt?: string; url?: string }
  | { id: string; type: "heading"; text: string; align?: "left" | "center" }
  | { id: string; type: "text"; text: string; align?: "left" | "center" }
  | { id: string; type: "button"; label: string; url: string; align?: "left" | "center" }
  | { id: string; type: "image"; imageUrl: string; alt?: string; url?: string }
  | {
      id: string;
      type: "products";
      title?: string;
      buttonLabel?: string;
      items: EmailProduct[];
    }
  | {
      id: string;
      type: "offer";
      title: string;
      subtitle?: string;
      code?: string;
      terms?: string;
      buttonLabel?: string;
      url?: string;
    }
  | { id: string; type: "divider" }
  | { id: string; type: "spacer"; size?: "sm" | "md" | "lg" };

export type EmailBlockType = EmailBlock["type"];

export interface EmailProduct {
  id: string;
  name: string;
  description?: string | null;
  /** Already formatted in the shop's currency, e.g. "£9.99". */
  price?: string | null;
  imageUrl?: string | null;
}

export interface EmailTheme {
  /** Buttons, offer border, links. */
  primaryColor: string;
  /** Text on primary-coloured buttons. */
  buttonTextColor: string;
  /** Page behind the card. */
  backgroundColor: string;
  /** The 600px card. */
  cardColor: string;
  textColor: string;
}

export interface EmailDesign {
  theme: EmailTheme;
  blocks: EmailBlock[];
}

/** Placeholder a link can use for "this restaurant's online ordering page". */
export const STOREFRONT_LINK = "{{storefront}}";

export const DEFAULT_EMAIL_THEME: EmailTheme = {
  primaryColor: "#e4572e",
  buttonTextColor: "#ffffff",
  backgroundColor: "#f4f4f5",
  cardColor: "#ffffff",
  textColor: "#18181b",
};

// ── Audience ─────────────────────────────────────────────────────────────────

export type EmailSegment =
  | "ALL"
  | "RECENT" // ordered in the last N days
  | "LAPSED" // ordered before, but not in the last N days
  | "NEW" // first order in the last N days
  | "LOYAL" // at least N orders
  | "TOP_SPENDERS" // spent at least X
  | "NEVER_ORDERED"; // subscribed (import / sign-up) but no order yet

export interface EmailAudience {
  segment: EmailSegment;
  /** RECENT / LAPSED / NEW window. */
  days?: number;
  /** LOYAL threshold. */
  minOrders?: number;
  /** TOP_SPENDERS threshold, in the shop's currency (major units). */
  minSpend?: number;
  /** Only people who ordered from this brand. */
  brandId?: string | null;
  tags?: string[];
}

export const EMAIL_SEGMENTS: {
  id: EmailSegment;
  label: string;
  hint: string;
  param?: "days" | "minOrders" | "minSpend";
  defaultValue?: number;
}[] = [
  { id: "ALL", label: "All subscribers", hint: "Everyone who agreed to hear from you" },
  {
    id: "RECENT",
    label: "Recent customers",
    hint: "Ordered in the last N days",
    param: "days",
    defaultValue: 30,
  },
  {
    id: "LAPSED",
    label: "Lapsed customers",
    hint: "Haven't ordered for N days — win them back",
    param: "days",
    defaultValue: 45,
  },
  {
    id: "NEW",
    label: "New customers",
    hint: "First order in the last N days",
    param: "days",
    defaultValue: 30,
  },
  {
    id: "LOYAL",
    label: "Regulars",
    hint: "Placed at least N orders",
    param: "minOrders",
    defaultValue: 5,
  },
  {
    id: "TOP_SPENDERS",
    label: "Big spenders",
    hint: "Spent at least this much in total",
    param: "minSpend",
    defaultValue: 100,
  },
  {
    id: "NEVER_ORDERED",
    label: "Subscribed, never ordered",
    hint: "Signed up or imported, no order yet",
  },
];

// ── Rendering ────────────────────────────────────────────────────────────────

export interface EmailLink {
  url: string;
  /** True when the link points at the restaurant's own storefront — those get
   *  the attribution parameter that ties an order back to this email. */
  storefront: boolean;
}

export interface RenderEmailContext {
  brandName: string;
  logoUrl?: string | null;
  storefrontUrl: string;
  /** Postal address for the footer — required in marketing email. */
  footerAddress?: string | null;
  unsubscribeUrl: string;
  firstName?: string | null;
  preheader?: string | null;
  /** Rewrites each link (click tracking). Called once per link, in order. */
  trackLink?: (link: EmailLink, index: number) => string;
  /** 1×1 open-tracking image, appended to the body. */
  openPixelUrl?: string | null;
}

export interface RenderedEmail {
  html: string;
  text: string;
  /** Every link in render order — the click-redirect table. */
  links: EmailLink[];
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;
function color(v: unknown, fallback: string): string {
  const s = String(v ?? "").trim();
  return HEX.test(s) ? s : fallback;
}

/** Replace {{first_name}} / {{brand_name}}; unknown tags are dropped rather
 *  than shown to a customer as literal braces. */
export function personalise(
  text: string,
  vars: { firstName?: string | null; brandName?: string | null },
): string {
  const first = String(vars.firstName ?? "").trim() || "there";
  return String(text ?? "")
    .replace(/\{\{\s*(first_?name|name)\s*\}\}/gi, first)
    .replace(/\{\{\s*brand(_?name)?\s*\}\}/gi, String(vars.brandName ?? ""))
    .replace(/\{\{\s*(?!storefront\s*\}\})[^}]*\}\}/g, "");
}

/** A link the email may carry: http(s), mailto, tel, or the storefront token.
 *  Anything else (javascript:, data:) becomes the storefront. */
export function resolveEmailUrl(raw: string | undefined | null, storefrontUrl: string): EmailLink {
  const s = String(raw ?? "").trim();
  if (!s || s === STOREFRONT_LINK) return { url: storefrontUrl, storefront: true };
  if (/^(mailto|tel):/i.test(s)) return { url: s, storefront: false };
  if (/^https?:\/\//i.test(s)) {
    return { url: s, storefront: s.startsWith(storefrontUrl.split("?")[0] ?? storefrontUrl) };
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return { url: `https://${s}`, storefront: false };
  return { url: storefrontUrl, storefront: true };
}

/** Light inline formatting for text blocks: paragraphs, line breaks, **bold**. */
function richText(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => p.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>"))
    .join('</p><p style="margin:0 0 14px 0;">');
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function renderEmail(design: EmailDesign, ctx: RenderEmailContext): RenderedEmail {
  const theme: EmailTheme = {
    primaryColor: color(design?.theme?.primaryColor, DEFAULT_EMAIL_THEME.primaryColor),
    buttonTextColor: color(design?.theme?.buttonTextColor, DEFAULT_EMAIL_THEME.buttonTextColor),
    backgroundColor: color(design?.theme?.backgroundColor, DEFAULT_EMAIL_THEME.backgroundColor),
    cardColor: color(design?.theme?.cardColor, DEFAULT_EMAIL_THEME.cardColor),
    textColor: color(design?.theme?.textColor, DEFAULT_EMAIL_THEME.textColor),
  };
  const links: EmailLink[] = [];
  const text: string[] = [];
  const vars = { firstName: ctx.firstName, brandName: ctx.brandName };
  const p = (s: string) => personalise(s, vars);

  const href = (raw: string | undefined | null): string => {
    const link = resolveEmailUrl(raw, ctx.storefrontUrl);
    const index = links.length;
    links.push(link);
    return escapeHtml(ctx.trackLink ? ctx.trackLink(link, index) : link.url);
  };

  const button = (label: string, url: string | undefined, align: "left" | "center" = "center") => {
    const h = href(url);
    text.push(`${p(label)}: ${links[links.length - 1]!.url}`);
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="margin:${align === "center" ? "0 auto" : "0"};">
<tr><td bgcolor="${theme.primaryColor}" style="border-radius:8px;background:${theme.primaryColor};">
<a href="${h}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:700;color:${theme.buttonTextColor};text-decoration:none;border-radius:8px;">${escapeHtml(p(label))}</a>
</td></tr></table>`;
  };

  const row = (inner: string, pad = "0 32px 20px 32px") =>
    `<tr><td style="padding:${pad};">${inner}</td></tr>`;

  const parts: string[] = [];
  for (const b of design?.blocks ?? []) {
    switch (b.type) {
      case "header": {
        const logo = ctx.logoUrl
          ? `<img src="${escapeHtml(ctx.logoUrl)}" alt="${escapeHtml(ctx.brandName)}" height="56" style="display:block;margin:0 auto;height:56px;max-width:220px;width:auto;border:0;">`
          : "";
        const name =
          b.showName !== false || !ctx.logoUrl
            ? `<div style="font-family:${FONT};font-size:20px;font-weight:800;color:${theme.textColor};margin-top:${logo ? "10px" : "0"};">${escapeHtml(ctx.brandName)}</div>`
            : "";
        parts.push(row(`<div style="text-align:center;">${logo}${name}</div>`, "28px 32px 20px 32px"));
        break;
      }
      case "hero":
      case "image": {
        if (!b.imageUrl) break;
        const img = `<img src="${escapeHtml(b.imageUrl)}" alt="${escapeHtml(b.alt ?? "")}" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;${b.type === "image" ? "border-radius:10px;" : ""}">`;
        const linked = b.url ? `<a href="${href(b.url)}" target="_blank">${img}</a>` : img;
        parts.push(b.type === "hero" ? `<tr><td style="padding:0 0 24px 0;">${linked}</td></tr>` : row(linked));
        break;
      }
      case "heading": {
        if (!b.text?.trim()) break;
        text.push(p(b.text).toUpperCase());
        parts.push(
          row(
            `<h1 style="margin:0;font-family:${FONT};font-size:28px;line-height:1.25;font-weight:800;color:${theme.textColor};text-align:${b.align ?? "center"};">${escapeHtml(p(b.text))}</h1>`,
          ),
        );
        break;
      }
      case "text": {
        if (!b.text?.trim()) break;
        text.push(p(b.text).replace(/\*\*/g, ""));
        parts.push(
          row(
            `<div style="font-family:${FONT};font-size:16px;line-height:1.6;color:${theme.textColor};text-align:${b.align ?? "center"};"><p style="margin:0 0 14px 0;">${richText(p(b.text))}</p></div>`,
            "0 32px 8px 32px",
          ),
        );
        break;
      }
      case "button": {
        if (!b.label?.trim()) break;
        parts.push(row(button(b.label, b.url, b.align ?? "center"), "4px 32px 24px 32px"));
        break;
      }
      case "products": {
        const items = (b.items ?? []).filter((i) => i?.name).slice(0, 12);
        if (!items.length) break;
        if (b.title?.trim()) {
          text.push(p(b.title));
          parts.push(
            row(
              `<h2 style="margin:0;font-family:${FONT};font-size:20px;font-weight:800;color:${theme.textColor};text-align:center;">${escapeHtml(p(b.title))}</h2>`,
              "8px 32px 16px 32px",
            ),
          );
        }
        const cells = items.map((it) => {
          const h = href(STOREFRONT_LINK);
          text.push(`- ${it.name}${it.price ? ` ${it.price}` : ""}`);
          const img = it.imageUrl
            ? `<a href="${h}" target="_blank"><img src="${escapeHtml(it.imageUrl)}" alt="${escapeHtml(it.name)}" width="250" style="display:block;width:100%;height:auto;border:0;border-radius:10px 10px 0 0;"></a>`
            : "";
          return `<td width="50%" valign="top" style="padding:6px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e4e4e7;border-radius:10px;">
<tr><td>${img}</td></tr>
<tr><td style="padding:12px 14px 14px 14px;font-family:${FONT};">
<div style="font-size:15px;font-weight:700;color:${theme.textColor};">${escapeHtml(it.name)}</div>
${it.description ? `<div style="font-size:13px;line-height:1.45;color:#71717a;margin-top:4px;">${escapeHtml(String(it.description).slice(0, 110))}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;"><tr>
<td style="font-size:15px;font-weight:800;color:${theme.textColor};">${escapeHtml(it.price ?? "")}</td>
<td align="right"><a href="${h}" target="_blank" style="font-size:13px;font-weight:700;color:${theme.primaryColor};text-decoration:none;">${escapeHtml(b.buttonLabel || "Order")} &rarr;</a></td>
</tr></table>
</td></tr></table></td>`;
        });
        const rows: string[] = [];
        for (let i = 0; i < cells.length; i += 2) {
          rows.push(`<tr>${cells[i]}${cells[i + 1] ?? '<td width="50%" style="padding:6px;"></td>'}</tr>`);
        }
        parts.push(
          row(
            `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join("")}</table>`,
            "0 26px 20px 26px",
          ),
        );
        break;
      }
      case "offer": {
        if (!b.title?.trim()) break;
        text.push(`${p(b.title)}${b.subtitle ? ` — ${p(b.subtitle)}` : ""}${b.code ? ` Code: ${b.code}` : ""}`);
        const code = b.code?.trim()
          ? `<div style="display:inline-block;margin-top:14px;padding:10px 18px;border-radius:8px;background:#f4f4f5;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:20px;font-weight:800;letter-spacing:2px;color:${theme.textColor};">${escapeHtml(b.code.trim().toUpperCase())}</div>`
          : "";
        const cta = b.buttonLabel?.trim()
          ? `<div style="margin-top:18px;">${button(b.buttonLabel, b.url)}</div>`
          : "";
        const terms = b.terms?.trim()
          ? `<div style="margin-top:12px;font-size:12px;line-height:1.5;color:#71717a;">${escapeHtml(p(b.terms))}</div>`
          : "";
        parts.push(
          row(
            `<div style="border:2px dashed ${theme.primaryColor};border-radius:14px;padding:24px 20px;text-align:center;font-family:${FONT};">
<div style="font-size:32px;line-height:1.15;font-weight:900;color:${theme.primaryColor};">${escapeHtml(p(b.title))}</div>
${b.subtitle ? `<div style="margin-top:6px;font-size:16px;color:${theme.textColor};">${escapeHtml(p(b.subtitle))}</div>` : ""}
${code}${cta}${terms}</div>`,
          ),
        );
        break;
      }
      case "divider":
        parts.push(row(`<div style="border-top:1px solid #e4e4e7;font-size:0;line-height:0;">&nbsp;</div>`, "4px 32px 20px 32px"));
        break;
      case "spacer": {
        const h = b.size === "lg" ? 40 : b.size === "sm" ? 8 : 20;
        parts.push(`<tr><td style="height:${h}px;font-size:0;line-height:0;">&nbsp;</td></tr>`);
        break;
      }
    }
  }

  // The footer is not a block: it cannot be deleted. Who sent this, where they
  // are, and how to stop it — a legal requirement, and what keeps a restaurant
  // out of the spam folder (people report what they can't unsubscribe from).
  const unsub = escapeHtml(ctx.unsubscribeUrl);
  const footer = `<tr><td style="padding:24px 32px 32px 32px;font-family:${FONT};font-size:12px;line-height:1.6;color:#71717a;text-align:center;">
You're receiving this because you signed up for offers from ${escapeHtml(ctx.brandName)}.<br>
${ctx.footerAddress ? `${escapeHtml(ctx.footerAddress)}<br>` : ""}
<a href="${unsub}" target="_blank" style="color:#71717a;text-decoration:underline;">Unsubscribe</a>
</td></tr>`;
  text.push("", `You're receiving this because you signed up for offers from ${ctx.brandName}.`);
  if (ctx.footerAddress) text.push(ctx.footerAddress);
  text.push(`Unsubscribe: ${ctx.unsubscribeUrl}`);

  const preheader = ctx.preheader?.trim()
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(p(ctx.preheader))}${"&#847;&zwnj;&nbsp;".repeat(30)}</div>`
    : "";
  const pixel = ctx.openPixelUrl
    ? `<img src="${escapeHtml(ctx.openPixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;">`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${escapeHtml(ctx.brandName)}</title></head>
<body style="margin:0;padding:0;background:${theme.backgroundColor};">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${theme.backgroundColor}" style="background:${theme.backgroundColor};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${theme.cardColor}" style="width:100%;max-width:600px;background:${theme.cardColor};border-radius:16px;overflow:hidden;">
${parts.join("\n")}
${footer}
</table>
</td></tr></table>
${pixel}
</body></html>`;

  return { html, text: text.join("\n").replace(/\n{3,}/g, "\n\n").trim(), links };
}

// ── Starter templates ────────────────────────────────────────────────────────

export interface EmailTemplateContext {
  brandName: string;
  primaryColor?: string | null;
  products?: EmailProduct[];
  heroImageUrl?: string | null;
}

export interface EmailTemplate {
  id: string;
  name: string;
  description: string;
  subject: string;
  preheader: string;
  /** Suggested audience — the operator can change it. */
  audience: EmailAudience;
  build: (ctx: EmailTemplateContext) => EmailDesign;
}

let seq = 0;
const bid = (t: string) => `${t}_${(++seq).toString(36)}`;

function theme(ctx: EmailTemplateContext): EmailTheme {
  return { ...DEFAULT_EMAIL_THEME, primaryColor: color(ctx.primaryColor, DEFAULT_EMAIL_THEME.primaryColor) };
}
const hero = (ctx: EmailTemplateContext): EmailBlock[] =>
  ctx.heroImageUrl ? [{ id: bid("hero"), type: "hero", imageUrl: ctx.heroImageUrl, url: STOREFRONT_LINK }] : [];
const products = (ctx: EmailTemplateContext, title: string, n = 4): EmailBlock[] =>
  ctx.products?.length
    ? [{ id: bid("products"), type: "products", title, buttonLabel: "Order", items: ctx.products.slice(0, n) }]
    : [];

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: "weekend-offer",
    name: "Weekend offer",
    description: "A discount code with a clear deadline",
    subject: "{{first_name}}, 20% off this weekend 🎉",
    preheader: "Our treat — use your code before Sunday night.",
    audience: { segment: "ALL" },
    build: (ctx) => ({
      theme: theme(ctx),
      blocks: [
        { id: bid("header"), type: "header", showName: true },
        ...hero(ctx),
        { id: bid("heading"), type: "heading", text: "Your weekend treat is here" },
        {
          id: bid("text"),
          type: "text",
          text: "Hi {{first_name}}, thanks for ordering with us. This weekend only, enjoy a little something off your next order.",
        },
        {
          id: bid("offer"),
          type: "offer",
          title: "20% OFF",
          subtitle: "Your whole order, ordered online",
          code: "WEEKEND20",
          terms: "Valid until Sunday 11pm when ordering direct. One use per customer.",
          buttonLabel: "Order now",
          url: STOREFRONT_LINK,
        },
        ...products(ctx, "Customer favourites"),
      ],
    }),
  },
  {
    id: "win-back",
    name: "We miss you",
    description: "Bring back customers who haven't ordered lately",
    subject: "We miss you, {{first_name}} — here's 15% off",
    preheader: "It's been a while. Come back for something good.",
    audience: { segment: "LAPSED", days: 45 },
    build: (ctx) => ({
      theme: theme(ctx),
      blocks: [
        { id: bid("header"), type: "header", showName: true },
        { id: bid("heading"), type: "heading", text: "It's been a while, {{first_name}}" },
        {
          id: bid("text"),
          type: "text",
          text: "We haven't seen you for a bit and the kitchen has missed you. Here's a little welcome-back gift.",
        },
        {
          id: bid("offer"),
          type: "offer",
          title: "15% OFF",
          subtitle: "Welcome back",
          code: "MISSYOU15",
          terms: "Valid for 7 days when ordering direct.",
          buttonLabel: "Claim my discount",
          url: STOREFRONT_LINK,
        },
        ...products(ctx, "Still on the menu"),
      ],
    }),
  },
  {
    id: "new-dish",
    name: "New on the menu",
    description: "Show off a new dish or a seasonal special",
    subject: "New on our menu 👀",
    preheader: "Fresh from the kitchen — be the first to try it.",
    audience: { segment: "ALL" },
    build: (ctx) => ({
      theme: theme(ctx),
      blocks: [
        { id: bid("header"), type: "header", showName: true },
        ...hero(ctx),
        { id: bid("heading"), type: "heading", text: "Something new just landed" },
        {
          id: bid("text"),
          type: "text",
          text: "Our chefs have been busy. Be one of the first to try what's new, available now for delivery and collection.",
        },
        ...products(ctx, "Just added", 2),
        { id: bid("button"), type: "button", label: "See the full menu", url: STOREFRONT_LINK },
      ],
    }),
  },
  {
    id: "happy-hour",
    name: "Happy hour",
    description: "Fill quiet hours with a time-limited deal",
    subject: "Happy hour starts at 3pm ⏰",
    preheader: "Quiet afternoon? Not with these prices.",
    audience: { segment: "RECENT", days: 60 },
    build: (ctx) => ({
      theme: theme(ctx),
      blocks: [
        { id: bid("header"), type: "header", showName: true },
        { id: bid("heading"), type: "heading", text: "Happy hour is on" },
        {
          id: bid("text"),
          type: "text",
          text: "Every weekday from **3pm to 5pm**, everything on the menu is cheaper when you order direct.",
        },
        {
          id: bid("offer"),
          type: "offer",
          title: "25% OFF",
          subtitle: "Weekdays, 3pm – 5pm",
          buttonLabel: "Order now",
          url: STOREFRONT_LINK,
        },
        ...products(ctx, "Perfect for an afternoon treat"),
      ],
    }),
  },
  {
    id: "free-delivery",
    name: "Free delivery",
    description: "Remove the reason people order elsewhere",
    subject: "Free delivery tonight 🛵",
    preheader: "No delivery fee when you order direct.",
    audience: { segment: "ALL" },
    build: (ctx) => ({
      theme: theme(ctx),
      blocks: [
        { id: bid("header"), type: "header", showName: true },
        ...hero(ctx),
        { id: bid("heading"), type: "heading", text: "Delivery's on us tonight" },
        {
          id: bid("text"),
          type: "text",
          text: "Order direct from us tonight and we'll deliver for free, with no app fees and no service charge. Just great food.",
        },
        { id: bid("button"), type: "button", label: "Order with free delivery", url: STOREFRONT_LINK },
        ...products(ctx, "Tonight's favourites"),
      ],
    }),
  },
  {
    id: "loyalty-thanks",
    name: "Thank your regulars",
    description: "A thank-you reward for your best customers",
    subject: "A thank-you for our regulars ❤️",
    preheader: "You keep us going — here's something back.",
    audience: { segment: "LOYAL", minOrders: 5 },
    build: (ctx) => ({
      theme: theme(ctx),
      blocks: [
        { id: bid("header"), type: "header", showName: true },
        { id: bid("heading"), type: "heading", text: "Thank you, {{first_name}}" },
        {
          id: bid("text"),
          type: "text",
          text: "You're one of our regulars and we don't take that for granted. Your next dessert is on us.",
        },
        {
          id: bid("offer"),
          type: "offer",
          title: "FREE DESSERT",
          subtitle: "With your next order",
          code: "THANKYOU",
          terms: "Valid for 14 days when ordering direct.",
          buttonLabel: "Order now",
          url: STOREFRONT_LINK,
        },
      ],
    }),
  },
  {
    id: "announcement",
    name: "News & announcement",
    description: "Opening hours, a new branch, holiday notice",
    subject: "News from {{brand_name}}",
    preheader: "A quick update from us.",
    audience: { segment: "ALL" },
    build: (ctx) => ({
      theme: theme(ctx),
      blocks: [
        { id: bid("header"), type: "header", showName: true },
        ...hero(ctx),
        { id: bid("heading"), type: "heading", text: "We've got news" },
        {
          id: bid("text"),
          type: "text",
          text: "Hi {{first_name}},\n\nWrite your update here: new opening hours, a new branch, or a holiday notice.\n\nSee you soon!",
          align: "left",
        },
        { id: bid("button"), type: "button", label: "Visit our ordering page", url: STOREFRONT_LINK },
      ],
    }),
  },
  {
    id: "blank",
    name: "Start from scratch",
    description: "Just your logo and a message",
    subject: "",
    preheader: "",
    audience: { segment: "ALL" },
    build: (ctx) => ({
      theme: theme(ctx),
      blocks: [
        { id: bid("header"), type: "header", showName: true },
        { id: bid("heading"), type: "heading", text: "Your headline" },
        { id: bid("text"), type: "text", text: "Write your message here." },
        { id: bid("button"), type: "button", label: "Order now", url: STOREFRONT_LINK },
      ],
    }),
  },
];

export function newEmailBlockId(type: EmailBlockType): string {
  return `${type}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
