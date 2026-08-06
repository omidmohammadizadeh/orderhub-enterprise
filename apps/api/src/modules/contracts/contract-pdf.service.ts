import { Injectable, Logger } from "@nestjs/common";
import { LOGO_PNG_BASE64 } from "./logo";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

/**
 * The countersigned copy — the artefact a client actually keeps.
 *
 * pdf-lib rather than a headless browser on purpose. Puppeteer renders HTML
 * beautifully and would drag a whole Chromium download into a Render build
 * that already has five documented ways to fail; pdf-lib is pure JS with no
 * native binary. The trade is that we lay text out ourselves, which is fine
 * because the only HTML we render is our own template output — a known, small
 * subset of tags, not arbitrary web pages.
 *
 * Two shapes come out of here:
 *   • written contract → a typeset document, then the certificate page
 *   • uploaded PDF     → the operator's original, UNTOUCHED, with the
 *     certificate appended. Never re-rendered: the signed artefact must be
 *     the document they actually read, byte for byte.
 */

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 56;
const INK = rgb(0.09, 0.09, 0.11);
const MUTED = rgb(0.45, 0.45, 0.5);
const RULE = rgb(0.85, 0.85, 0.88);

/**
 * Written into the Producer field of every PDF we generate, so a finished
 * document can be told apart from a blank agreement later.
 */
export const ORDERHUB_PDF_MARKER = "Order Hub Contracts";
// Brand orange — used only for the party headings, so the two sides of the
// agreement are findable at a glance on a page that is otherwise grey.
const ACCENT = rgb(0.98, 0.45, 0.09);

interface Block {
  text: string;
  size: number;
  bold: boolean;
  gapAfter: number;
  bullet?: boolean;
}

/**
 * What the certificate says about each party.
 *
 * Pure and exported so the rule can be tested directly: a rendered PDF has
 * Flate-compressed content streams, so asserting on the bytes proves nothing
 * about whether our side was named as a company or as a person.
 */
export function certificateParties(contract: any): Array<{
  heading: string;
  rows: Array<[string, string]>;
}> {
  const signed = contract.signedAt ? new Date(contract.signedAt) : null;
  const issued = contract.sentAt ? new Date(contract.sentAt) : null;
  const stamp = (d: Date | null) =>
    d ? `${d.toUTCString()} (${d.toISOString()})` : "—";
  const issuer = contract.issuer ?? null;

  return [
    {
      heading: "PARTY 1 — THE PROVIDER",
      rows: [
        // A COMPANY, never a person. Order Hub is party to the agreement as a
        // legal entity; whichever member of staff pressed send is an
        // administrative detail, and naming them would imply they signed
        // personally and bound themselves.
        ["Company", issuer?.name ?? "Order Hub Solutions Ltd"],
        ...(issuer?.companyNumber
          ? ([["Company number", issuer.companyNumber]] as Array<[string, string]>)
          : []),
        ...(issuer?.address
          ? ([["Registered address", issuer.address]] as Array<[string, string]>)
          : []),
        ["Agreement issued", stamp(issued)],
      ],
    },
    {
      heading: "PARTY 2 — THE CLIENT",
      rows: [
        ["Signed by", contract.signerName ?? "—"],
        ["Email", contract.signerEmail ?? contract.recipientEmail ?? "—"],
        ["Company", contract.recipientCompany ?? "—"],
        ["Signed at", stamp(signed)],
        ["IP address", contract.signerIp ?? "—"],
        ["Device", contract.signerUserAgent ?? "—"],
      ],
    },
    {
      heading: "DOCUMENT",
      rows: [["Reference", contract.id ?? "—"]],
    },
  ];
}

@Injectable()
export class ContractPdfService {
  private readonly logger = new Logger(ContractPdfService.name);

  async build(contract: any, events: any[] = []): Promise<Buffer> {
    // A contract can point at a file that is itself a finished Order Hub
    // document — created before uploading one was blocked. Appending our
    // certificate to it produces two, the first naming whoever signed the
    // sample rather than this client.
    //
    // Where the contract also has written wording, use that instead: the
    // agreement is repaired on the next download rather than reprinting a
    // stranger's signature every time it is opened. Where there is no
    // wording to fall back on, the file is all we have — say so loudly.
    let useFile = !!contract.fileUrl;
    if (contract.fileUrl && (await this.isOrderHubOutput(contract.fileUrl))) {
      if (contract.bodyHtml) {
        this.logger.warn(
          `Contract ${contract.id} points at a finished Order Hub document — rendering its written wording instead so the certificate is this client's`,
        );
        useFile = false;
      } else {
        this.logger.error(
          `Contract ${contract.id} is built on a finished Order Hub document and has no written wording — its PDF will carry the original signer's certificate. Delete and re-send it.`,
        );
      }
    }

    const pdf = useFile
      ? await this.loadOriginal(contract.fileUrl)
      : await PDFDocument.create();

    const regular = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);

    // Never fatal: a missing letterhead is a cosmetic problem, a download that
    // 500s on a signed agreement is not.
    let logo: any = null;
    try {
      logo = await pdf.embedPng(Buffer.from(LOGO_PNG_BASE64, "base64"));
    } catch (err: any) {
      this.logger.warn(`Contract logo embed failed: ${err?.message ?? err}`);
    }

    if (!useFile) {
      this.renderBody(pdf, contract, regular, bold, logo);
    }
    this.renderCertificate(pdf, contract, events, regular, bold, italic, logo);

    // Stamp the output so we can recognise our own work later. An operator
    // who uploads a finished, signed document as a TEMPLATE gets its baked-in
    // certificate on every contract they then send — someone else's name and
    // a stale reference, printed as if it were the new signer. That has
    // happened twice; a marker is the only way to spot it, since a PDF's text
    // is compressed and cannot simply be searched.
    // Keywords, not Producer: pdf-lib overwrites Producer with its own name
    // inside save(), so a marker put there silently disappears.
    pdf.setKeywords([ORDERHUB_PDF_MARKER]);
    pdf.setCreator("Order Hub");

    const bytes = await pdf.save();
    return Buffer.from(bytes);
  }

  /**
   * Is this PDF one WE generated — i.e. a finished document rather than a
   * blank agreement to be filled in?
   *
   * Used to stop a signed output being saved as a template. Never throws: a
   * file we cannot read is not evidence of anything, and refusing an upload
   * because of a network blip would be worse than the problem.
   */
  async isOrderHubOutput(url: string): Promise<boolean> {
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      const pdf = await PDFDocument.load(await res.arrayBuffer(), {
        ignoreEncryption: true,
      });
      return (pdf.getKeywords() ?? "").includes(ORDERHUB_PDF_MARKER);
    } catch (err: any) {
      this.logger.warn(
        `Could not inspect uploaded PDF ${url}: ${err?.message ?? err}`,
      );
      return false;
    }
  }

  /**
   * Fetch the uploaded original. If it can't be read we still produce a
   * certificate rather than failing the download — a signature record with a
   * note explaining the original is missing beats no document at all, and it
   * makes the problem visible instead of silent.
   */
  private async loadOriginal(url: string): Promise<PDFDocument> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      return await PDFDocument.load(bytes);
    } catch (err: any) {
      this.logger.warn(
        `Contract original not embeddable (${url}): ${err?.message ?? err}`,
      );
      return PDFDocument.create();
    }
  }

  // ── Written contracts ────────────────────────────────────────────────────

  /** Our own template HTML → blocks. Not a general HTML parser. */
  private htmlToBlocks(html: string): Block[] {
    const blocks: Block[] = [];
    // <br> becomes a paragraph break before tags are stripped, or the text
    // either side of it would run together into one line.
    const normalised = html.replace(/<br\s*\/?>/gi, "</p><p>");
    const tagRe =
      /<(h1|h2|h3|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(normalised))) {
      const tag = m[1]!.toLowerCase();
      const text = decodeEntities(stripTags(m[2] ?? "")).trim();
      if (!text) continue;
      if (tag === "h1") blocks.push({ text, size: 17, bold: true, gapAfter: 10 });
      else if (tag === "h2")
        blocks.push({ text, size: 14, bold: true, gapAfter: 8 });
      else if (tag === "h3")
        blocks.push({ text, size: 12, bold: true, gapAfter: 6 });
      else if (tag === "li")
        blocks.push({ text, size: 10.5, bold: false, gapAfter: 4, bullet: true });
      else blocks.push({ text, size: 10.5, bold: false, gapAfter: 8 });
    }
    // A template with no recognised tags would silently produce a blank
    // document, so fall back to the whole thing as plain paragraphs.
    if (blocks.length === 0) {
      const plain = decodeEntities(stripTags(normalised)).trim();
      if (plain) {
        for (const para of plain.split(/\n{2,}/)) {
          if (para.trim())
            blocks.push({
              text: para.trim(),
              size: 10.5,
              bold: false,
              gapAfter: 8,
            });
        }
      }
    }
    return blocks;
  }

  private renderBody(
    pdf: PDFDocument,
    contract: any,
    regular: PDFFont,
    bold: PDFFont,
    logo?: any,
  ) {
    let page = pdf.addPage(A4);
    let y = A4[1] - MARGIN;
    const width = A4[0] - MARGIN * 2;

    y = drawLogo(page, logo, y);

    page.drawText(contract.title ?? "Agreement", {
      x: MARGIN,
      y,
      size: 20,
      font: bold,
      color: INK,
    });
    y -= 30;

    for (const block of this.htmlToBlocks(contract.bodyHtml ?? "")) {
      const font = block.bold ? bold : regular;
      const indent = block.bullet ? 14 : 0;
      const lines = wrap(block.text, font, block.size, width - indent);
      const lineHeight = block.size * 1.45;

      for (let i = 0; i < lines.length; i++) {
        if (y < MARGIN + lineHeight) {
          page = pdf.addPage(A4);
          y = A4[1] - MARGIN;
        }
        if (block.bullet && i === 0) {
          page.drawText("•", {
            x: MARGIN,
            y,
            size: block.size,
            font: regular,
            color: INK,
          });
        }
        page.drawText(lines[i]!, {
          x: MARGIN + indent,
          y,
          size: block.size,
          font,
          color: INK,
        });
        y -= lineHeight;
      }
      y -= block.gapAfter;
    }
  }

  // ── The certificate ──────────────────────────────────────────────────────

  /**
   * The page that carries the evidence. This is the part that matters in a
   * dispute: who, when, from where, and against which immutable record.
   */
  private renderCertificate(
    pdf: PDFDocument,
    contract: any,
    events: any[],
    regular: PDFFont,
    bold: PDFFont,
    italic: PDFFont,
    logo?: any,
  ) {
    const page = pdf.addPage(A4);
    let y = A4[1] - MARGIN;
    const width = A4[0] - MARGIN * 2;

    y = drawLogo(page, logo, y);

    page.drawText("Certificate of Electronic Signature", {
      x: MARGIN,
      y,
      size: 17,
      font: bold,
      color: INK,
    });
    y -= 22;
    page.drawText(contract.title ?? "", {
      x: MARGIN,
      y,
      size: 11,
      font: regular,
      color: MUTED,
    });
    y -= 20;
    line(page, y, width);
    y -= 24;

    const block = (heading: string, rows: Array<[string, string]>) => {
      page.drawText(heading, {
        x: MARGIN,
        y,
        size: 9,
        font: bold,
        color: ACCENT,
      });
      y -= 16;
      for (const [label, value] of rows) {
        page.drawText(label, {
          x: MARGIN,
          y,
          size: 9,
          font: bold,
          color: MUTED,
        });
        const lines = wrap(String(value), regular, 10, width - 130);
        for (let i = 0; i < lines.length; i++) {
          page.drawText(lines[i]!, {
            x: MARGIN + 130,
            y: y - i * 13,
            size: 10,
            font: regular,
            color: INK,
          });
        }
        y -= Math.max(1, lines.length) * 13 + 7;
      }
      y -= 10;
    };

    for (const party of certificateParties(contract)) {
      block(party.heading, party.rows);
    }

    y -= 10;
    line(page, y, width);
    y -= 30;

    // The signature itself. An oblique face reads as a signature without
    // pretending to be handwriting we never captured.
    page.drawText("Signature", {
      x: MARGIN,
      y,
      size: 9,
      font: bold,
      color: MUTED,
    });
    y -= 26;
    page.drawText(contract.signerName ?? "", {
      x: MARGIN,
      y,
      size: 22,
      font: italic,
      color: INK,
    });
    y -= 12;
    line(page, y, 220);
    y -= 16;
    page.drawText(
      "Typed by the signer, who confirmed intent to sign electronically.",
      { x: MARGIN, y, size: 8.5, font: regular, color: MUTED },
    );

    // Oldest first — the order things actually happened, which is how anyone
    // reading this reconstructs the story. Sorted explicitly rather than
    // reversing the caller's array: that quietly depended on the DB's
    // orderBy, so any caller passing ascending events printed it backwards.
    const trail = [...events]
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
      .slice(0, 14);
    if (trail.length) {
      y -= 30;
      page.drawText("Audit trail", {
        x: MARGIN,
        y,
        size: 9,
        font: bold,
        color: MUTED,
      });
      y -= 16;
      for (const e of trail) {
        if (y < MARGIN) break;
        const when = new Date(e.createdAt).toISOString();
        const text = `${when}  ${e.type}${e.ip ? `  from ${e.ip}` : ""}`;
        page.drawText(text, {
          x: MARGIN,
          y,
          size: 8.5,
          font: regular,
          color: INK,
        });
        y -= 12;
      }
    }

    page.drawText(
      "Generated by Order Hub. This certificate records evidence of an electronic signature",
      { x: MARGIN, y: MARGIN - 18, size: 7.5, font: regular, color: MUTED },
    );
    page.drawText(
      "under the Electronic Communications Act 2000.",
      { x: MARGIN, y: MARGIN - 28, size: 7.5, font: regular, color: MUTED },
    );
  }
}

// ── Text helpers ───────────────────────────────────────────────────────────

/**
 * Letterhead. Returns the new baseline so callers keep laying out downward
 * without knowing the logo's height — and returns `y` untouched when
 * there is no logo, so a failed embed silently costs nothing.
 */
function drawLogo(page: PDFPage, logo: any, y: number): number {
  if (!logo) return y;
  const h = 34;
  const w = (logo.width / logo.height) * h;
  page.drawImage(logo, { x: MARGIN, y: y - h + 8, width: w, height: h });
  return y - h - 6;
}

function line(page: PDFPage, y: number, width: number) {
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: MARGIN + width, y },
    thickness: 0.75,
    color: RULE,
  });
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

/** The named entities an operator plausibly types into the template editor. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  pound: "£",
  euro: "€",
  cent: "¢",
  yen: "¥",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  plusmn: "±",
  frac12: "½",
  frac14: "¼",
  times: "×",
  divide: "÷",
  percnt: "%",
  frac34: "¾",
  laquo: "«",
  raquo: "»",
  micro: "µ",
  sup2: "²",
  sup3: "³",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  bull: "•",
  middot: "·",
  sect: "§",
  para: "¶",
  dagger: "†",
};

/**
 * HTML entities → characters.
 *
 * `&amp;` is decoded LAST, deliberately. Doing it first turns `&amp;pound;`
 * into `&pound;` and then into `£` — the operator wrote a literal ampersand
 * and got a currency symbol. Decoding it last makes that impossible.
 *
 * This is not cosmetic: the first render of a real template printed
 * "&pound;49.00" in the fee clause, because only five entities were handled.
 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      safeFromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      safeFromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (whole, name: string) => {
      const lower = name.toLowerCase();
      if (lower === "amp") return whole; // handled below, on purpose
      return NAMED_ENTITIES[lower] ?? whole;
    })
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
}

/** A malformed entity like `&#999999999;` must not throw mid-render. */
function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * Greedy word wrap against real glyph widths.
 *
 * A single word longer than the line (a URL, a long reference) is split
 * character-wise rather than left to overflow off the page edge — silently
 * losing the end of a clause is worse than an ugly break.
 *
 * WinAnsi is all the standard fonts can encode, so anything outside it is
 * replaced before measuring. pdf-lib throws on un-encodable characters, and a
 * smart quote pasted from Word would otherwise fail the whole download.
 */
export function wrap(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const safe = toWinAnsi(text);
  const words = safe.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
      continue;
    }
    let chunk = "";
    for (const ch of word) {
      if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    current = chunk;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export function toWinAnsi(s: string): string {
  return String(s ?? "")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    // Anything still outside Latin-1 can't be encoded by a standard font.
    // The `u` flag matters: without it an emoji is two UTF-16 surrogates and
    // comes out as "??" instead of a single placeholder.
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/gu, "?");
}
