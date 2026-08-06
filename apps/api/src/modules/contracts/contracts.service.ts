import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { EmailService } from "../../infrastructure/email/email.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ContractPdfService } from "./contract-pdf.service";
import { STARTER_TEMPLATES } from "./starter-templates";
import { defaultIssuer, resolveIssuer, type Issuer } from "./issuer";

/**
 * E-signature contracts.
 *
 * The legal weight of an electronic signature in the UK comes from evidence,
 * not from the picture of a squiggle: proof that a specific person opened a
 * specific document at a specific time and acted deliberately to adopt it.
 * Every transition therefore writes a ContractEvent carrying IP and
 * user-agent, and the document body is FROZEN onto the contract row when it
 * is created. Reading it back through the template would mean an operator
 * editing a template silently rewrites what a counterparty already signed.
 */

export type ContractStatus =
  | "DRAFT"
  | "SENT"
  | "OPENED"
  | "SIGNED"
  | "VOIDED";

/** Statuses a contract can still be signed from. */
const SIGNABLE: ContractStatus[] = ["SENT", "OPENED"];

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly subscriptions: SubscriptionsService,
    private readonly pdf: ContractPdfService,
  ) {}

  private webBase(): string {
    return (
      this.config.get<string>("WEB_URL") ??
      "https://www.orderhubsolutions.com"
    ).replace(/\/+$/, "");
  }

  /**
   * 32 random bytes, base64url. This is the ONLY credential guarding a
   * contract — there is no login on the signing page — so it is sized to be
   * unguessable rather than short and tidy like the SMS payment codes, which
   * trade entropy for fitting in one text segment. Nothing here goes by SMS.
   */
  private mintToken(): string {
    return randomBytes(32).toString("base64url");
  }

  private signingUrl(token: string): string {
    return `${this.webBase()}/contract/${token}`;
  }

  /**
   * Who the contract is FROM, for the certificate. Platform details by
   * default; per-contract overrides stored on the row win field by field so an
   * operator can issue on behalf of a different entity without reconfiguring
   * the deployment.
   */
  private issuerFor(contract: any): Issuer {
    const base = defaultIssuer((k) => this.config.get<string>(k));
    return resolveIssuer(base, (contract?.issuer as Partial<Issuer>) ?? null);
  }

  // ── Templates ────────────────────────────────────────────────────────────

  async listTemplates(tenantId: string) {
    const rows = await (this.prisma as any).contractTemplate.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    });

    // Flag any file template that is actually a finished Order Hub document.
    //
    // One of these silently prints a stranger's name, signing date and IP on
    // every contract sent from it, because its own certificate page is inside
    // the file. Uploading one is now refused, but the ones already saved are
    // invisible until somebody reads a signed PDF closely — so the list says
    // which, rather than leaving it to be discovered by a client.
    const withFiles = rows.filter((r: any) => r.fileUrl);
    if (withFiles.length === 0) {
      return rows.map((r: any) => ({ ...r, isFinishedDocument: false }));
    }
    const flags = new Map<string, boolean>();
    await Promise.all(
      withFiles.map(async (r: any) => {
        flags.set(r.id, await this.pdf.isOrderHubOutput(r.fileUrl));
      }),
    );
    return rows.map((r: any) => ({
      ...r,
      isFinishedDocument: flags.get(r.id) ?? false,
    }));
  }

  /** The ready-made agreements on offer, and whether each is already added. */
  async listStarterTemplates(tenantId: string) {
    const existing = await (this.prisma as any).contractTemplate.findMany({
      where: { tenantId, deletedAt: null },
      select: { name: true },
    });
    const names = new Set(existing.map((t: any) => t.name));
    return STARTER_TEMPLATES.map((s) => ({
      key: s.key,
      name: s.name,
      description: s.description,
      installed: names.has(s.name),
      // The wording itself, so "New template" can start from the real
      // agreement instead of a stub. The dashboard used to prefill its own
      // hardcoded three-clause sample, which looked enough like a contract
      // that it got saved and sent as one.
      bodyHtml: s.bodyHtml,
    }));
  }

  /**
   * Copy a starter into the tenant's own templates.
   *
   * A copy, not a reference: the operator edits their version freely and a
   * later change to the shipped wording never rewrites an agreement that has
   * already gone out.
   */
  async installStarterTemplate(
    tenantId: string,
    key: string,
    userId?: string,
  ) {
    const starter = STARTER_TEMPLATES.find((s) => s.key === key);
    if (!starter) throw new NotFoundException("Unknown starter template");
    return this.createTemplate(
      tenantId,
      {
        name: starter.name,
        description: starter.description,
        bodyHtml: starter.bodyHtml,
      },
      userId,
    );
  }

  async createTemplate(
    tenantId: string,
    dto: {
      name: string;
      description?: string;
      bodyHtml?: string;
      fileUrl?: string;
      fileName?: string;
      fileType?: string;
      subscriptionAmountPence?: number;
    },
    userId?: string,
  ) {
    if (!dto.name?.trim()) {
      throw new BadRequestException("A template needs a name");
    }
    if (!dto.bodyHtml?.trim() && !dto.fileUrl?.trim()) {
      throw new BadRequestException(
        "A template needs either written content or an uploaded file",
      );
    }

    // Refuse a finished document as a template.
    //
    // A signed PDF we produced carries its own certificate page — someone
    // else's name, their signing date, a stale reference — and using it as a
    // template prints all of that on every contract sent from it, looking for
    // all the world like the new signer's details. It reads as a bug in the
    // system rather than the wrong file, and it has been reported twice.
    if (dto.fileUrl?.trim()) {
      const ours = await this.pdf.isOrderHubOutput(dto.fileUrl.trim());
      if (ours) {
        throw new BadRequestException(
          "That file is a completed Order Hub document, not a blank agreement — it already has a signature certificate inside it, which would appear on every contract you send. Upload the unsigned original, or start from a written template instead.",
        );
      }
    }

    return (this.prisma as any).contractTemplate.create({
      data: {
        tenantId,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        bodyHtml: dto.bodyHtml?.trim() || null,
        fileUrl: dto.fileUrl?.trim() || null,
        fileName: dto.fileName?.trim() || null,
        fileType: dto.fileType?.trim() || null,
        subscriptionAmountPence: dto.subscriptionAmountPence ?? null,
        createdByUserId: userId ?? null,
      },
    });
  }

  async updateTemplate(
    tenantId: string,
    templateId: string,
    dto: Record<string, any>,
  ) {
    const existing = await (this.prisma as any).contractTemplate.findFirst({
      where: { id: templateId, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException("Template not found");
    return (this.prisma as any).contractTemplate.update({
      where: { id: templateId },
      data: {
        name: dto.name?.trim() ?? undefined,
        description: dto.description?.trim() ?? undefined,
        bodyHtml: dto.bodyHtml ?? undefined,
        fileUrl: dto.fileUrl ?? undefined,
        fileName: dto.fileName ?? undefined,
        fileType: dto.fileType ?? undefined,
        subscriptionAmountPence:
          dto.subscriptionAmountPence === undefined
            ? undefined
            : dto.subscriptionAmountPence,
      },
    });
  }

  /** Soft delete — contracts already sent keep their frozen copy regardless. */
  async deleteTemplate(tenantId: string, templateId: string) {
    const existing = await (this.prisma as any).contractTemplate.findFirst({
      where: { id: templateId, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException("Template not found");
    await (this.prisma as any).contractTemplate.update({
      where: { id: templateId },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Amend a contract that has been sent but not signed.
   *
   * A SIGNED contract is never editable. That is the whole value of the
   * thing: the signed artefact has to be exactly what was agreed, and an
   * "edit" afterwards would silently rewrite history that someone is bound
   * by. Withdraw it and send a fresh one instead.
   *
   * Amending one the client has ALREADY OPENED is allowed but recorded. They
   * may have read different terms to the ones they end up signing, and the
   * audit trail is the only place that fact can live. The status rolls back
   * to SENT so the board stops claiming they have read the current version.
   *
   * The signing token is deliberately unchanged, so a link already sitting in
   * someone's inbox keeps working — reissuing it would strand every copy of
   * the link already handed out.
   */
  async update(
    tenantId: string,
    contractId: string,
    dto: {
      title?: string;
      recipientName?: string;
      recipientEmail?: string;
      recipientCompany?: string | null;
      locationId?: string | null;
      subscriptionAmountPence?: number | null;
      commissionPercent?: number | null;
      customerServiceChargePence?: number | null;
    },
  ) {
    const contract = await (this.prisma as any).contract.findFirst({
      where: { id: contractId, tenantId, deletedAt: null },
      include: { location: { select: { id: true, name: true } } },
    });
    if (!contract) throw new NotFoundException("Contract not found");
    if (contract.status === "SIGNED") {
      throw new BadRequestException(
        "This contract has been signed and can no longer be changed. Withdraw it and send a new one.",
      );
    }
    if (contract.status === "VOIDED") {
      throw new BadRequestException(
        "This contract was withdrawn. Send a new one instead.",
      );
    }

    const pick = <T>(next: T | undefined, current: T): T =>
      next === undefined ? current : next;

    const recipientName = pick(dto.recipientName?.trim(), contract.recipientName);
    const recipientEmail = pick(
      dto.recipientEmail?.trim().toLowerCase(),
      contract.recipientEmail,
    );
    if (!recipientName || !recipientEmail) {
      throw new BadRequestException("A name and email are required");
    }

    const amount = pick(dto.subscriptionAmountPence, contract.subscriptionAmountPence);

    const commissionPercent =
      dto.commissionPercent === undefined
        ? contract.commissionPercent
        : dto.commissionPercent != null && Number(dto.commissionPercent) > 0
          ? Math.round(Number(dto.commissionPercent) * 100) / 100
          : null;
    if (commissionPercent != null && commissionPercent > 100) {
      throw new BadRequestException("Commission can't be more than 100%");
    }

    const serviceChargePence =
      dto.customerServiceChargePence === undefined
        ? contract.customerServiceChargePence
        : dto.customerServiceChargePence != null &&
            Number(dto.customerServiceChargePence) > 0
          ? Math.round(Number(dto.customerServiceChargePence))
          : null;

    let locationId = pick(dto.locationId, contract.locationId);
    let location = contract.location;
    if (locationId && locationId !== contract.locationId) {
      location = await this.prisma.location.findFirst({
        where: { id: locationId, brand: { tenantId } },
        select: { id: true, name: true },
      });
      if (!location) throw new NotFoundException("Location not found");
    } else if (!locationId) {
      location = null;
    }

    // Re-render from the ORIGINAL wording, not from the template as it stands
    // today — an amendment changes the figures that were agreed, not clauses
    // somebody edited in the template last week.
    const bodyHtml = contract.sourceHtml
      ? this.fillPlaceholders(contract.sourceHtml, {
          recipientName,
          recipientEmail,
          recipientCompany: dto.recipientCompany?.trim() ?? contract.recipientCompany ?? "",
          location: location?.name ?? "",
          date: new Date(contract.createdAt).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "long",
            year: "numeric",
          }),
          amount: amount ? `£${(amount / 100).toFixed(2)}` : "",
          commission: commissionPercent != null ? `${commissionPercent}%` : "",
          serviceCharge:
            serviceChargePence != null
              ? `£${(serviceChargePence / 100).toFixed(2)}`
              : "",
        })
      : contract.bodyHtml;

    const wasOpened = contract.status === "OPENED" || !!contract.firstOpenedAt;

    const updated = await (this.prisma as any).contract.update({
      where: { id: contract.id },
      data: {
        title: pick(dto.title?.trim(), contract.title),
        recipientName,
        recipientEmail,
        recipientCompany:
          dto.recipientCompany === undefined
            ? contract.recipientCompany
            : dto.recipientCompany?.trim() || null,
        locationId: locationId || null,
        subscriptionAmountPence: amount,
        commissionPercent,
        customerServiceChargePence: serviceChargePence,
        bodyHtml,
        // Back to SENT: the board should not go on saying they have read this
        // when what they read is not what is there now.
        status: contract.status === "OPENED" ? "SENT" : contract.status,
      },
      include: { location: { select: { id: true, name: true } } },
    });

    await this.recordEvent(contract.id, "AMENDED", {
      wasOpened,
      bodyRerendered: !!contract.sourceHtml,
    });

    if (!contract.sourceHtml) {
      this.logger.warn(
        `Contract ${contract.id} amended but has no sourceHtml — figures updated, body left as-is`,
      );
    }

    return this.serialise(updated);
  }

  /**
   * Remove a contract from the operator's list.
   *
   * Soft, always. A signed contract is the record of an agreement somebody is
   * bound by and its event trail is the evidence behind it; a hard delete
   * would destroy both to tidy a list. The row and its events survive, the
   * contract leaves every listing, and the signing link stops working — which
   * matters most for an unsigned one somebody still has the link to.
   */
  async remove(tenantId: string, contractId: string) {
    const contract = await (this.prisma as any).contract.findFirst({
      where: { id: contractId, tenantId, deletedAt: null },
      select: { id: true, status: true, title: true },
    });
    if (!contract) throw new NotFoundException("Contract not found");

    await (this.prisma as any).contract.update({
      where: { id: contract.id },
      data: { deletedAt: new Date() },
    });
    await this.recordEvent(contract.id, "DELETED", {
      statusWhenDeleted: contract.status,
    });

    // Worth a line in the log: deleting a signed agreement is a deliberate
    // act with consequences, and "where did that contract go" is a question
    // somebody asks eventually.
    this.logger.log(
      `Contract ${contract.id} ("${contract.title}") deleted while ${contract.status}`,
    );
    return { deleted: true };
  }

  /** Platform issuer details, so the compose form can prefill them. */
  issuerDefaults(): Issuer {
    return defaultIssuer((k) => this.config.get<string>(k));
  }

  // ── Contracts ────────────────────────────────────────────────────────────

  async list(tenantId: string, status?: string) {
    const rows = await (this.prisma as any).contract.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(status && status !== "ALL" ? { status } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: {
        location: { select: { id: true, name: true } },
        template: { select: { id: true, name: true } },
      },
      take: 300,
    });
    return rows.map((r: any) => this.serialise(r));
  }

  async get(tenantId: string, contractId: string) {
    const row = await (this.prisma as any).contract.findFirst({
      where: { id: contractId, tenantId, deletedAt: null },
      include: {
        location: { select: { id: true, name: true } },
        template: { select: { id: true, name: true } },
        events: { orderBy: { createdAt: "desc" }, take: 100 },
      },
    });
    if (!row) throw new NotFoundException("Contract not found");
    return { ...this.serialise(row), events: row.events };
  }

  /**
   * Build a contract, copying the template's content onto it. From here the
   * template can change freely without touching this agreement.
   *
   * `{{placeholders}}` are substituted now, for the same reason — so what the
   * operator previews is byte-for-byte what the signer sees.
   */
  async create(
    tenantId: string,
    dto: {
      templateId?: string;
      title?: string;
      bodyHtml?: string;
      fileUrl?: string;
      fileName?: string;
      fileType?: string;
      recipientName: string;
      recipientEmail: string;
      recipientCompany?: string;
      recipientCompanyNumber?: string;
      recipientAddress?: string;
      recipientPhone?: string;
      locationCount?: number;
      locationId?: string;
      subscriptionAmountPence?: number;
      /** Commission per order as a percentage. Blank/0 omits the clause. */
      commissionPercent?: number;
      /** Per-order charge the CUSTOMER pays, in pence. Blank/0 omits it. */
      customerServiceChargePence?: number;
      issuer?: Partial<Issuer> | null;
    },
    userId?: string,
  ) {
    if (!dto.recipientName?.trim() || !dto.recipientEmail?.trim()) {
      throw new BadRequestException("Recipient name and email are required");
    }

    let template: any = null;
    if (dto.templateId) {
      template = await (this.prisma as any).contractTemplate.findFirst({
        where: { id: dto.templateId, tenantId, deletedAt: null },
      });
      if (!template) throw new NotFoundException("Template not found");
    }

    const title = (dto.title?.trim() || template?.name || "").trim();
    if (!title) throw new BadRequestException("A contract needs a title");

    let bodyHtml = dto.bodyHtml ?? template?.bodyHtml ?? null;
    const fileUrl = dto.fileUrl ?? template?.fileUrl ?? null;
    if (!bodyHtml && !fileUrl) {
      throw new BadRequestException(
        "A contract needs either written content or an uploaded file",
      );
    }

    // Location is resolved before substitution so {{location}} can use it.
    let location: any = null;
    if (dto.locationId) {
      location = await this.prisma.location.findFirst({
        where: { id: dto.locationId, brand: { tenantId } },
        select: { id: true, name: true },
      });
      if (!location) throw new NotFoundException("Location not found");
    }

    const amount =
      dto.subscriptionAmountPence ??
      template?.subscriptionAmountPence ??
      null;

    // Both optional. A blank box means "this term does not apply" and removes
    // the clause; 0 is treated the same way, since a 0% commission clause is
    // noise on an agreement rather than a term worth stating.
    const commissionPercent =
      dto.commissionPercent != null && Number(dto.commissionPercent) > 0
        ? Math.round(Number(dto.commissionPercent) * 100) / 100
        : null;
    if (commissionPercent != null && commissionPercent > 100) {
      throw new BadRequestException("Commission can't be more than 100%");
    }

    const serviceChargePence =
      dto.customerServiceChargePence != null &&
      Number(dto.customerServiceChargePence) > 0
        ? Math.round(Number(dto.customerServiceChargePence))
        : null;

    const locationCount =
      dto.locationCount != null && Number(dto.locationCount) > 0
        ? Math.round(Number(dto.locationCount))
        : null;

    // Kept before substitution so an amendment can re-render with new figures.
    const sourceHtml = bodyHtml ?? null;

    if (bodyHtml) {
      bodyHtml = this.fillPlaceholders(bodyHtml, {
        recipientName: dto.recipientName.trim(),
        recipientEmail: dto.recipientEmail.trim(),
        recipientCompany: dto.recipientCompany?.trim() ?? "",
        recipientCompanyNumber: dto.recipientCompanyNumber?.trim() ?? "",
        recipientAddress: dto.recipientAddress?.trim() ?? "",
        recipientPhone: dto.recipientPhone?.trim() ?? "",
        locationCount: locationCount != null ? String(locationCount) : "",
        // "1 location" / "3 locations" — so the clause reads properly either
        // way instead of "1 locations".
        locationWord:
          locationCount != null
            ? `${locationCount} location${locationCount === 1 ? "" : "s"}`
            : "",
        location: location?.name ?? "",
        date: new Date().toLocaleDateString("en-GB", {
          day: "numeric",
          month: "long",
          year: "numeric",
        }),
        amount: amount ? `£${(amount / 100).toFixed(2)}` : "",
        // Blank when not set, which is also what makes the matching
        // {{#commission}} / {{#serviceCharge}} clauses disappear.
        commission:
          commissionPercent != null ? `${commissionPercent}%` : "",
        serviceCharge:
          serviceChargePence != null
            ? `£${(serviceChargePence / 100).toFixed(2)}`
            : "",
      });
    }

    const contract = await (this.prisma as any).contract.create({
      data: {
        tenantId,
        commissionPercent,
        customerServiceChargePence: serviceChargePence,
        templateId: template?.id ?? null,
        locationId: location?.id ?? null,
        title,
        bodyHtml,
        sourceHtml,
        fileUrl,
        fileName: dto.fileName ?? template?.fileName ?? null,
        fileType: dto.fileType ?? template?.fileType ?? null,
        recipientName: dto.recipientName.trim(),
        recipientEmail: dto.recipientEmail.trim().toLowerCase(),
        recipientCompany: dto.recipientCompany?.trim() || null,
        recipientCompanyNumber: dto.recipientCompanyNumber?.trim() || null,
        recipientAddress: dto.recipientAddress?.trim() || null,
        recipientPhone: dto.recipientPhone?.trim() || null,
        locationCount,
        subscriptionAmountPence: amount,
        // Only stored when it differs from the platform defaults, so changing
        // the registered address later updates every contract that never
        // needed an override.
        issuer: dto.issuer ?? null,
        status: "DRAFT",
        token: this.mintToken(),
        createdByUserId: userId ?? null,
      },
      include: { location: { select: { id: true, name: true } } },
    });

    await this.recordEvent(contract.id, "CREATED", {});
    return this.serialise(contract);
  }

  /** `{{name}}` → value. Unknown keys are left alone, not blanked. */
  private fillPlaceholders(
    html: string,
    values: Record<string, string>,
  ): string {
    // Optional clauses first: {{#commission}}…{{/commission}} keeps its
    // contents only when that value is present and non-empty, otherwise the
    // whole block goes.
    //
    // This is why a blank commission field removes the clause rather than
    // printing "0%". A term negotiated down to zero and a term that was never
    // offered read very differently to whoever is signing, and the second is
    // what an empty box means.
    const withSections = html.replace(
      /\{\{#\s*([a-zA-Z0-9_]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g,
      (_whole: string, key: string, inner: string) => {
        const v = values[key];
        return v !== undefined && v !== null && String(v).trim() !== ""
          ? inner
          : "";
      },
    );

    return withSections.replace(
      /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
      (whole: string, key: string) => values[key] ?? whole,
    );
  }

  /**
   * Mark as sent and email the link. `emailIt: false` is the "copy a link"
   * path — same state change, no email, because the operator is going to
   * paste the link into WhatsApp or read it down the phone.
   */
  async send(
    tenantId: string,
    contractId: string,
    opts: { emailIt?: boolean; message?: string } = {},
  ) {
    const contract = await (this.prisma as any).contract.findFirst({
      where: { id: contractId, tenantId, deletedAt: null },
    });
    if (!contract) throw new NotFoundException("Contract not found");
    if (contract.status === "SIGNED") {
      throw new BadRequestException("That contract is already signed");
    }
    if (contract.status === "VOIDED") {
      throw new BadRequestException("That contract was voided");
    }

    const isResend = contract.status !== "DRAFT";
    const updated = await (this.prisma as any).contract.update({
      where: { id: contractId },
      data: {
        // A resend must NOT reset OPENED back to SENT — that would erase the
        // evidence that they had already read it.
        status: contract.status === "DRAFT" ? "SENT" : contract.status,
        sentAt: contract.sentAt ?? new Date(),
        lastRemindedAt: isResend ? new Date() : null,
      },
      include: { location: { select: { id: true, name: true } } },
    });

    if (opts.emailIt !== false) {
      await this.emailContract(updated, opts.message, isResend);
    }
    await this.recordEvent(contractId, isResend ? "REMINDED" : "SENT", {
      emailed: opts.emailIt !== false,
    });

    return {
      ...this.serialise(updated),
      signingUrl: this.signingUrl(updated.token),
    };
  }

  private async emailContract(
    contract: any,
    message?: string,
    isReminder = false,
  ) {
    const url = this.signingUrl(contract.token);
    const subject = isReminder
      ? `Reminder: please sign “${contract.title}”`
      : `Please sign “${contract.title}”`;

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#18181b">
        <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(contract.title)}</h1>
        <p style="font-size:15px;line-height:1.5;margin:0 0 16px">
          Hi ${escapeHtml(contract.recipientName)},
        </p>
        <p style="font-size:15px;line-height:1.5;margin:0 0 16px">
          ${
            message
              ? escapeHtml(message)
              : "Please review and sign the agreement below."
          }
        </p>
        <p style="margin:24px 0">
          <a href="${url}"
             style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;
                    padding:12px 22px;border-radius:8px;font-weight:600;font-size:15px">
            Review &amp; sign
          </a>
        </p>
        <p style="font-size:12px;color:#71717a;line-height:1.5;margin:16px 0 0">
          This link is unique to you — please don't forward it.
          If the button doesn't work, paste this into your browser:<br>
          <span style="word-break:break-all">${url}</span>
        </p>
      </div>`;

    try {
      await this.email.send({
        to: contract.recipientEmail,
        subject,
        html,
        text: `${contract.title}\n\nPlease review and sign: ${url}`,
      });
    } catch (err: any) {
      // A failed email must not lose the state change — the operator can
      // still copy the link, and the dashboard shows it as sent.
      this.logger.error(
        `Contract email failed for ${contract.id}: ${err?.message ?? err}`,
      );
    }
  }

  async void(tenantId: string, contractId: string, reason?: string) {
    const contract = await (this.prisma as any).contract.findFirst({
      where: { id: contractId, tenantId, deletedAt: null },
    });
    if (!contract) throw new NotFoundException("Contract not found");
    if (contract.status === "SIGNED") {
      throw new BadRequestException(
        "A signed contract can't be voided — it's already been agreed",
      );
    }
    const updated = await (this.prisma as any).contract.update({
      where: { id: contractId },
      data: { status: "VOIDED", voidedAt: new Date() },
      include: { location: { select: { id: true, name: true } } },
    });
    await this.recordEvent(contractId, "VOIDED", { reason: reason ?? null });
    return this.serialise(updated);
  }

  // ── Public signing surface ───────────────────────────────────────────────

  /**
   * Everything the signing page renders. Deliberately narrow: the token
   * holder is an outside party, so this returns the document and nothing
   * about the tenant, the operator, or any other contract.
   */
  async getByToken(
    token: string,
    ctx: { ip?: string; userAgent?: string } = {},
  ) {
    const contract = await (this.prisma as any).contract.findUnique({
      where: { token, deletedAt: null },
      include: { location: { select: { id: true, name: true } } },
    });
    if (!contract) throw new NotFoundException("Contract not found");

    // First open flips SENT → OPENED. Later opens only add an event, so the
    // "when did they first read it" evidence stays intact.
    if (contract.status === "SENT") {
      await (this.prisma as any).contract.update({
        where: { id: contract.id },
        data: { status: "OPENED", firstOpenedAt: new Date() },
      });
      contract.status = "OPENED";
      contract.firstOpenedAt = new Date();
    }
    if (contract.status !== "VOIDED") {
      await this.recordEvent(contract.id, "OPENED", {}, ctx);
    }

    return {
      title: contract.title,
      bodyHtml: contract.bodyHtml,
      fileUrl: contract.fileUrl,
      fileName: contract.fileName,
      fileType: contract.fileType,
      recipientName: contract.recipientName,
      recipientEmail: contract.recipientEmail,
      recipientCompany: contract.recipientCompany,
      locationName: contract.location?.name ?? null,
      subscriptionAmountPence: contract.subscriptionAmountPence,
      status: contract.status,
      signedAt: contract.signedAt,
      signerName: contract.signerName,
      subscriptionStartedAt: contract.subscriptionStartedAt,
      canSubscribe:
        contract.status === "SIGNED" &&
        !!contract.subscriptionAmountPence &&
        !!contract.locationId,
    };
  }

  async sign(
    token: string,
    dto: { signerName: string; signerEmail?: string; signatureImageUrl?: string },
    ctx: { ip?: string; userAgent?: string } = {},
  ) {
    const contract = await (this.prisma as any).contract.findUnique({
      where: { token, deletedAt: null },
    });
    if (!contract) throw new NotFoundException("Contract not found");
    if (contract.status === "SIGNED") {
      throw new BadRequestException("This contract has already been signed");
    }
    if (!SIGNABLE.includes(contract.status)) {
      throw new BadRequestException(
        contract.status === "VOIDED"
          ? "This contract was withdrawn and can no longer be signed"
          : "This contract isn't ready to sign yet",
      );
    }
    if (!dto.signerName?.trim()) {
      throw new BadRequestException("Please type your full name to sign");
    }

    const updated = await (this.prisma as any).contract.update({
      where: { id: contract.id },
      data: {
        status: "SIGNED",
        signedAt: new Date(),
        signerName: dto.signerName.trim(),
        signerEmail:
          dto.signerEmail?.trim().toLowerCase() || contract.recipientEmail,
        signatureImageUrl: dto.signatureImageUrl?.trim() || null,
        signerIp: ctx.ip ?? null,
        signerUserAgent: ctx.userAgent ?? null,
      },
      include: { location: { select: { id: true, name: true } } },
    });

    await this.recordEvent(
      contract.id,
      "SIGNED",
      { signerName: updated.signerName },
      ctx,
    );

    this.notifySigned(updated).catch((err) =>
      this.logger.warn(
        `Signed-notification failed for ${contract.id}: ${err?.message ?? err}`,
      ),
    );

    return {
      status: updated.status,
      signedAt: updated.signedAt,
      signerName: updated.signerName,
      canSubscribe:
        !!updated.subscriptionAmountPence && !!updated.locationId,
      subscriptionAmountPence: updated.subscriptionAmountPence,
    };
  }

  /** Confirmation to the signer — their own copy of what they agreed to. */
  private async notifySigned(contract: any) {
    await this.email.send({
      to: contract.signerEmail ?? contract.recipientEmail,
      subject: `Signed: ${contract.title}`,
      html: `
        <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#18181b">
          <h1 style="font-size:20px;margin:0 0 16px">Thanks — that's signed</h1>
          <p style="font-size:15px;line-height:1.5">
            <strong>${escapeHtml(contract.title)}</strong> was signed by
            ${escapeHtml(contract.signerName ?? "")} on
            ${new Date(contract.signedAt).toLocaleString("en-GB")}.
          </p>
          <p style="font-size:15px;line-height:1.5">
            You can view it again any time:<br>
            <a href="${this.signingUrl(contract.token)}">${this.signingUrl(contract.token)}</a>
          </p>
        </div>`,
    });
  }

  /**
   * Start the subscription the signed contract offers.
   *
   * The amount and the location come from the CONTRACT, never from the
   * request — otherwise whoever holds the link could subscribe someone
   * else's location, or subscribe this one for a penny. The token holder
   * chooses only whether to press the button.
   */
  async startSubscription(
    token: string,
    ctx: { ip?: string; userAgent?: string } = {},
  ) {
    const contract = await (this.prisma as any).contract.findUnique({
      where: { token, deletedAt: null },
    });
    if (!contract) throw new NotFoundException("Contract not found");
    if (contract.status !== "SIGNED") {
      throw new BadRequestException(
        "Please sign the agreement before starting the subscription",
      );
    }
    if (!contract.subscriptionAmountPence || !contract.locationId) {
      throw new BadRequestException(
        "This contract doesn't include a subscription",
      );
    }

    // PLATFORM_ADMIN is passed because the caller is an unauthenticated
    // signer with no user of their own. It is safe precisely because every
    // input below is read off the contract row rather than the request.
    const result = await this.subscriptions.setPlan(
      contract.tenantId,
      contract.locationId,
      contract.subscriptionAmountPence,
      contract.signerEmail ?? contract.recipientEmail,
      undefined,
      "PLATFORM_ADMIN",
    );

    await (this.prisma as any).contract.update({
      where: { id: contract.id },
      data: { subscriptionStartedAt: new Date() },
    });
    await this.recordEvent(
      contract.id,
      "SUBSCRIBE_STARTED",
      { amountPence: contract.subscriptionAmountPence },
      ctx,
    );

    return { checkoutUrl: (result as any).checkoutUrl ?? null };
  }

  // ── Signed copy ──────────────────────────────────────────────────────────

  /**
   * The countersigned PDF. Built on demand rather than stored: the inputs are
   * immutable once signed, so a cached file could only ever drift from the
   * record, and re-rendering costs milliseconds.
   */
  async pdfForAdmin(tenantId: string, contractId: string) {
    const contract = await (this.prisma as any).contract.findFirst({
      where: { id: contractId, tenantId, deletedAt: null },
      include: {
        events: { orderBy: { createdAt: "desc" }, take: 50 },
        location: { select: { name: true } },
      },
    });
    if (!contract) throw new NotFoundException("Contract not found");
    return {
      buffer: await this.pdf.build(
        { ...contract, issuer: this.issuerFor(contract) },
        contract.events ?? [],
      ),
      filename: this.pdfFilename(contract),
    };
  }

  /**
   * The signer's own copy. Only once SIGNED — before that there is no
   * countersigned document to hand out, and offering one would imply the
   * agreement is settled when it isn't.
   */
  async pdfForToken(token: string) {
    const contract = await (this.prisma as any).contract.findUnique({
      where: { token, deletedAt: null },
      include: {
        events: { orderBy: { createdAt: "desc" }, take: 50 },
        location: { select: { name: true } },
      },
    });
    if (!contract) throw new NotFoundException("Contract not found");
    if (contract.status !== "SIGNED") {
      throw new BadRequestException(
        "A signed copy is available once the agreement has been signed",
      );
    }
    return {
      buffer: await this.pdf.build(
        { ...contract, issuer: this.issuerFor(contract) },
        contract.events ?? [],
      ),
      filename: this.pdfFilename(contract),
    };
  }

  private pdfFilename(contract: any): string {
    const safe = String(contract.title ?? "contract")
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60);
    return `${safe || "contract"}-signed.pdf`;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async recordEvent(
    contractId: string,
    type: string,
    meta: Record<string, any> = {},
    ctx: { ip?: string; userAgent?: string } = {},
  ) {
    try {
      await (this.prisma as any).contractEvent.create({
        data: {
          contractId,
          type,
          ip: ctx.ip ?? null,
          // Long enough to identify a browser, short enough not to bloat the
          // row when something sends a novel-length UA string.
          userAgent: ctx.userAgent?.slice(0, 400) ?? null,
          meta,
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `Contract event ${type} not recorded for ${contractId}: ${err?.message ?? err}`,
      );
    }
  }

  private serialise(row: any) {
    return {
      id: row.id,
      title: row.title,
      status: row.status as ContractStatus,
      recipientName: row.recipientName,
      recipientEmail: row.recipientEmail,
      recipientCompany: row.recipientCompany,
      recipientCompanyNumber: row.recipientCompanyNumber ?? null,
      recipientAddress: row.recipientAddress ?? null,
      recipientPhone: row.recipientPhone ?? null,
      locationCount: row.locationCount ?? null,
      locationId: row.locationId,
      locationName: row.location?.name ?? null,
      templateId: row.templateId,
      templateName: row.template?.name ?? null,
      subscriptionAmountPence: row.subscriptionAmountPence,
      commissionPercent: row.commissionPercent ?? null,
      customerServiceChargePence: row.customerServiceChargePence ?? null,
      hasFile: !!row.fileUrl,
      fileUrl: row.fileUrl,
      fileName: row.fileName,
      bodyHtml: row.bodyHtml,
      sentAt: row.sentAt,
      firstOpenedAt: row.firstOpenedAt,
      signedAt: row.signedAt,
      voidedAt: row.voidedAt,
      signerName: row.signerName,
      signerEmail: row.signerEmail,
      signerIp: row.signerIp,
      signatureImageUrl: row.signatureImageUrl,
      subscriptionStartedAt: row.subscriptionStartedAt,
      signingUrl: this.signingUrl(row.token),
      createdAt: row.createdAt,
    };
  }
}

/** Contract titles and names are operator input and land in an email body. */
function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
