import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { validateMenuJson } from "@orderhub/shared";
import { randomBytes } from "crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { fsaBusinessUrl, fsaIdFromUrl, FsaRatingsClient, type HygieneResult } from "../../common/fsa-ratings";
import { AiMenuParseService, type AiMenuFile } from "../menus/importers/ai-menu.service";
import { buildCommissionReport, type ProspectStatement, type ReportAssumptions } from "./commission-report";
import { StatementReaderService, toStatement, type StatementFile } from "./statement-reader.service";

// ── Prospects (Admin Dashboard → Prospects) ─────────────────────────────────
//
// What you show a shop before it signs: its own menu as a private preview, and
// what its statements say it pays in commission. Stands apart from tenants,
// brands and menus on purpose, so nothing here can take an order or show up in
// a merchant's data. When the shop signs, the menu is downloaded and goes in
// through the existing JSON menu import.
//
// Reading a file can outlast the ~60s proxy in front of the API, so it runs in
// the background and the screen polls the row's status.

const PREVIEW_DAYS = 30;
/** A READING row older than this lost its job to a restart. */
const READING_STALE_MS = 10 * 60_000;
const STALE_MESSAGE = "This was interrupted, so please upload the file again.";

type Row = NonNullable<Awaited<ReturnType<PrismaService["prospect"]["findUnique"]>>>;

export interface ExtractedMenuBody {
  draft: { categories?: unknown[]; [key: string]: unknown };
  shopName?: string;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  city?: string | null;
  postcode?: string | null;
}

const newToken = (): string => randomBytes(24).toString("hex");
const expiry = (): Date => new Date(Date.now() + PREVIEW_DAYS * 86_400_000);
const httpsOnly = (url: string | null | undefined): string | null =>
  url && /^https:\/\//i.test(url) ? url : null;

/** The shop name in a marketplace link, as a starting point the first saved
 *  page replaces. Regex rather than URL: only ever a label. */
export function nameFromLink(link: string | null | undefined): string | null {
  const path = /^https?:\/\/[^/]+\/([^?#]*)/i.exec(link?.trim() ?? "")?.[1];
  if (!path) return null;
  const parts = path.split("/").filter((p) => p && p.toLowerCase() !== "menu");
  const slug = parts[parts.length - 1]?.replace(/^restaurants-/, "");
  if (!slug) return null;
  return slug
    .split("-")
    .filter((w) => w && !/^(?:[a-z]{1,2}\d{1,2}[a-z]?|\d+)$/i.test(w))
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** Replaces a re-uploaded statement instead of counting its money twice. */
export function mergeStatements(
  existing: ProspectStatement[],
  incoming: ProspectStatement[],
): ProspectStatement[] {
  const sameStatement = (a: ProspectStatement, b: ProspectStatement) =>
    a.platform === b.platform &&
    !!a.periodStart &&
    !!a.periodEnd &&
    a.periodStart === b.periodStart &&
    a.periodEnd === b.periodEnd;
  return [...existing.filter((old) => !incoming.some((fresh) => sameStatement(old, fresh))), ...incoming];
}

/** A low score is a reason not to put the badge in front of the owner: it's
 *  public anyway, but the preview is meant to sell, and they know their score. */
export function hygieneWorthShowing(hygiene: { rating?: unknown } | null): boolean {
  const rating = String(hygiene?.rating ?? "");
  return ["3", "4", "5", "Pass", "Pass and Eat Safe"].includes(rating);
}

@Injectable()
export class ProspectsService {
  private readonly logger = new Logger(ProspectsService.name);
  private readonly fsa = new FsaRatingsClient();

  constructor(
    private readonly prisma: PrismaService,
    private readonly menuReader: AiMenuParseService,
    private readonly statementReader: StatementReaderService,
  ) {}

  async list() {
    const rows = await this.prisma.prospect.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    return rows.map((row) => this.toView(row));
  }

  async get(id: string) {
    return this.toView(await this.load(id));
  }

  async create(shopName: string | undefined, sourceUrl: string | undefined, userId: string) {
    const link = sourceUrl?.trim() || null;
    if (link && !/^https?:\/\//i.test(link)) {
      throw new BadRequestException("That link should start with https://");
    }
    const name = shopName?.trim() || nameFromLink(link);
    if (!name) throw new BadRequestException("Add the shop's name or its marketplace link.");
    const row = await this.prisma.prospect.create({
      data: {
        shopName: name,
        sourceUrl: link,
        previewToken: newToken(),
        previewExpiresAt: expiry(),
        createdByUserId: userId,
      },
    });
    return this.toView(row);
  }

  /** Permanent, and takes the owner's statement figures with it. */
  async remove(id: string) {
    await this.load(id);
    await this.prisma.prospect.delete({ where: { id } });
    return { deleted: true };
  }

  // ── Menu ──────────────────────────────────────────────────────────────────

  /** A menu the browser already pulled out of a saved Just Eat/Deliveroo page. */
  async saveExtractedMenu(id: string, body: ExtractedMenuBody) {
    await this.load(id);
    const check = validateMenuJson(body.draft);
    if (!check.ok) {
      throw new BadRequestException(`This menu can't be used: ${check.errors.slice(0, 3).join("; ")}`);
    }
    const row = await this.prisma.prospect.update({
      where: { id },
      data: {
        menu: body.draft as object,
        menuStatus: "READY",
        menuError: null,
        previewExpiresAt: expiry(),
        ...(body.shopName?.trim() ? { shopName: body.shopName.trim() } : {}),
        logoUrl: httpsOnly(body.logoUrl),
        bannerUrl: httpsOnly(body.bannerUrl),
        city: body.city?.trim() || null,
        postcode: body.postcode?.trim() || null,
      },
    });
    return this.toView(await this.lookUpHygiene(row));
  }

  /** Anything else (Uber Eats page, shop website, photo, PDF) goes to the AI
   *  menu reader. No photos come through this route. */
  async startMenuRead(id: string, files: AiMenuFile[]) {
    const row = await this.load(id);
    if (this.isReading(row.menuStatus, row.updatedAt)) {
      throw new BadRequestException("Already reading a menu for this shop.");
    }
    if (!this.menuReader.configured) {
      throw new BadRequestException("AI menu reading isn't configured (missing ANTHROPIC_API_KEY).");
    }
    const updated = await this.prisma.prospect.update({
      where: { id },
      data: { menuStatus: "READING", menuError: null },
    });
    void this.menuReader
      .parse(files)
      .then((draft) =>
        this.prisma.prospect.update({
          where: { id },
          data: {
            menu: draft as object,
            menuStatus: "READY",
            menuError: null,
            previewExpiresAt: expiry(),
            ...(draft.menuName?.trim() && !row.menu ? { shopName: draft.menuName.trim() } : {}),
          },
        }),
      )
      .catch((err) => this.failRead(id, "menu", err));
    return this.toView(updated);
  }

  async setHygieneLink(id: string, url: string) {
    await this.load(id);
    const fsaId = fsaIdFromUrl(url);
    if (!fsaId) throw new BadRequestException("That isn't a ratings.food.gov.uk business link.");
    const found = await this.fsa.hygieneById(fsaId);
    if (!found) throw new BadRequestException("No FSA record with that id, or the FSA didn't answer.");
    const row = await this.prisma.prospect.update({
      where: { id },
      data: { hygiene: this.hygieneJson(found) },
    });
    return this.toView(row);
  }

  private async lookUpHygiene(row: Row): Promise<Row> {
    if (!row.postcode) return row;
    // "A failed FSA call changes nothing": the client returns null on any error.
    const found = await this.fsa.findHygiene({ name: row.shopName, postcode: row.postcode });
    if (!found) return row;
    return this.prisma.prospect.update({ where: { id: row.id }, data: { hygiene: this.hygieneJson(found) } });
  }

  private hygieneJson(found: HygieneResult) {
    return {
      establishmentId: found.establishmentId,
      rating: found.rating,
      url: fsaBusinessUrl(found.establishmentId),
    };
  }

  // ── Statements ────────────────────────────────────────────────────────────

  async startStatementRead(id: string, files: StatementFile[]) {
    const row = await this.load(id);
    if (this.isReading(row.statementStatus, row.updatedAt)) {
      throw new BadRequestException("Already reading statements for this shop.");
    }
    const blocks = this.statementReader.buildBlocks(files);
    const updated = await this.prisma.prospect.update({
      where: { id },
      data: { statementStatus: "READING", statementError: null },
    });
    void this.statementReader
      .read(blocks)
      .then(async (incoming) => {
        const fresh = await this.load(id);
        await this.prisma.prospect.update({
          where: { id },
          data: {
            statements: mergeStatements(this.statementsOf(fresh), incoming) as object[],
            statementStatus: "READY",
            statementError: null,
          },
        });
      })
      .catch((err) => this.failRead(id, "statement", err));
    return this.toView(updated);
  }

  async addStatementByHand(id: string, body: unknown) {
    const row = await this.load(id);
    const statement = toStatement(body, "manual");
    if (!statement) throw new BadRequestException("Sales and commission are both needed.");
    const updated = await this.prisma.prospect.update({
      where: { id },
      data: { statements: mergeStatements(this.statementsOf(row), [statement]) as object[] },
    });
    return this.toView(updated);
  }

  async removeStatement(id: string, statementId: string) {
    const row = await this.load(id);
    const updated = await this.prisma.prospect.update({
      where: { id },
      data: { statements: this.statementsOf(row).filter((s) => s.id !== statementId) as object[] },
    });
    return this.toView(updated);
  }

  async setAssumptions(id: string, assumptions: Partial<ReportAssumptions>) {
    const row = await this.load(id);
    const updated = await this.prisma.prospect.update({
      where: { id },
      data: { assumptions: { ...((row.assumptions as object | null) ?? {}), ...assumptions } },
    });
    return this.toView(updated);
  }

  // ── What the owner's link shows ───────────────────────────────────────────

  /** Menu and shop identity only. Never the commission figures. */
  async publicPreview(token: string) {
    const row = await this.prisma.prospect.findUnique({ where: { previewToken: token } });
    if (!row || !row.menu || row.previewExpiresAt < new Date()) {
      throw new NotFoundException("This preview has ended.");
    }
    const hygiene = row.hygiene as { rating?: string; url?: string } | null;
    return {
      shopName: row.shopName,
      city: row.city,
      logoUrl: row.logoUrl,
      bannerUrl: row.bannerUrl,
      menu: row.menu,
      hygiene: hygieneWorthShowing(hygiene) ? { rating: hygiene!.rating, url: hygiene!.url } : null,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async load(id: string): Promise<Row> {
    const row = await this.prisma.prospect.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Prospect not found.");
    return row;
  }

  private statementsOf(row: Row): ProspectStatement[] {
    return Array.isArray(row.statements) ? (row.statements as unknown as ProspectStatement[]) : [];
  }

  private isReading(status: string, updatedAt: Date): boolean {
    return status === "READING" && Date.now() - updatedAt.getTime() < READING_STALE_MS;
  }

  private async failRead(id: string, what: "menu" | "statement", err: unknown) {
    const e = err as { message?: string; response?: { message?: string } };
    const message = e?.response?.message ?? e?.message ?? `Couldn't read this ${what}.`;
    this.logger.warn(`Prospect ${id} ${what} read failed: ${message}`);
    await this.prisma.prospect
      .update({
        where: { id },
        data:
          what === "menu"
            ? { menuStatus: "FAILED", menuError: message }
            : { statementStatus: "FAILED", statementError: message },
      })
      // The row may have been deleted while the read was running.
      .catch(() => undefined);
  }

  private toView(row: Row) {
    const statements = this.statementsOf(row);
    const menuStale = row.menuStatus === "READING" && !this.isReading(row.menuStatus, row.updatedAt);
    const statementStale =
      row.statementStatus === "READING" && !this.isReading(row.statementStatus, row.updatedAt);
    return {
      id: row.id,
      shopName: row.shopName,
      sourceUrl: row.sourceUrl,
      city: row.city,
      postcode: row.postcode,
      logoUrl: row.logoUrl,
      bannerUrl: row.bannerUrl,
      previewToken: row.previewToken,
      previewExpiresAt: row.previewExpiresAt,
      menu: row.menu,
      menuStatus: menuStale ? "FAILED" : row.menuStatus,
      menuError: menuStale ? STALE_MESSAGE : row.menuError,
      hygiene: row.hygiene,
      statements,
      statementStatus: statementStale ? "FAILED" : row.statementStatus,
      statementError: statementStale ? STALE_MESSAGE : row.statementError,
      report: buildCommissionReport(statements, row.assumptions),
      createdAt: row.createdAt,
    };
  }
}
