// Eat For Less — "Partner with Eat For Less" applications.
//
// A shop fills in the public form; we store it, keep its ID and bank
// statement in private storage, and run the checks we can run by ourselves
// (Companies House, the FSA hygiene rating). The Console then decides.

import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SupabaseStorageService } from "../uploads/supabase-storage.service";
import { EflChecksService, normaliseCompanyNumber, ratingBelowMinimum } from "./efl-checks";
import { toE164 } from "../sms/phone";

export interface ApplicationInput {
  businessName: string;
  companyNumber?: string;
  cuisine?: string;
  addressLine1: string;
  city: string;
  postcode: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  menuUrl?: string;
  hygieneUrl?: string;
  /** data: URLs — PDF, JPEG or PNG. */
  idDocument?: string;
  bankStatement?: string;
}

const DOC_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
};
// Two documents ride one JSON request, and the API takes 10 MB per request
// (main.ts). Base64 adds a third, so 3.5 MB each keeps both under the cap.
const MAX_DOC_BYTES = 3_500_000;

/** A data: URL as bytes, or a reason it can't be accepted. */
export function decodeDocument(dataUrl: string): { buffer: Buffer; contentType: string; ext: string } {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl.trim());
  const ext = m ? DOC_TYPES[m[1]!.toLowerCase()] : undefined;
  if (!m || !ext) throw new BadRequestException("Documents must be a PDF, JPG or PNG.");
  const buffer = Buffer.from(m[2]!, "base64");
  if (buffer.length > MAX_DOC_BYTES) throw new BadRequestException("Each document must be under 3.5 MB. A photo of it is fine.");
  return { buffer, contentType: m[1]!.toLowerCase(), ext };
}

@Injectable()
export class EflApplicationsService {
  private readonly logger = new Logger(EflApplicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
    private readonly checks: EflChecksService,
  ) {}

  async submit(input: ApplicationInput) {
    const phone = toE164(input.phone);
    if (!phone) throw new BadRequestException("Please enter a mobile number we can call, like 07700 900123.");
    const companyNumber = input.companyNumber ? normaliseCompanyNumber(input.companyNumber) : null;
    if (input.companyNumber && !companyNumber) {
      throw new BadRequestException("A company number is up to 8 letters and numbers.");
    }

    // Decode both before storing either, so a bad second file doesn't leave
    // an orphaned first one.
    const idDoc = input.idDocument ? decodeDocument(input.idDocument) : null;
    const bankDoc = input.bankStatement ? decodeDocument(input.bankStatement) : null;
    if ((idDoc || bankDoc) && !this.storage.isConfigured()) {
      throw new BadRequestException("We can't take documents right now. Please try again later.");
    }
    const idDocPath = idDoc ? await this.storage.uploadPrivate(idDoc.buffer, idDoc.contentType, "efl-applications", idDoc.ext) : null;
    const bankDocPath = bankDoc
      ? await this.storage.uploadPrivate(bankDoc.buffer, bankDoc.contentType, "efl-applications", bankDoc.ext)
      : null;

    const app = await this.prisma.eflApplication.create({
      data: {
        businessName: input.businessName.trim(),
        companyNumber,
        cuisine: input.cuisine?.trim() || null,
        addressLine1: input.addressLine1.trim(),
        city: input.city.trim(),
        postcode: input.postcode.trim().toUpperCase(),
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        phone,
        email: input.email.trim().toLowerCase(),
        menuUrl: input.menuUrl?.trim() || null,
        hygieneUrl: input.hygieneUrl?.trim() || null,
        idDocPath,
        bankDocPath,
      },
    });
    // The applicant shouldn't wait on two outside services to see "sent".
    void this.runChecks(app.id).catch((err) =>
      this.logger.warn(`Checks for application ${app.id} failed: ${(err as Error).message}`),
    );
    return { id: app.id, reference: app.id.slice(-6).toUpperCase() };
  }

  /** Companies House and the FSA, stored on the application as found. */
  async runChecks(id: string) {
    const app = await this.prisma.eflApplication.findUnique({ where: { id } });
    if (!app) throw new NotFoundException("Application not found");
    const [company, hygiene, config] = await Promise.all([
      this.checks.company(app.companyNumber),
      this.checks.findHygiene({ url: app.hygieneUrl, name: app.businessName, postcode: app.postcode }),
      this.prisma.eflConfig.findUnique({ where: { id: "default" } }),
    ]);
    const minimum = config?.minHygieneRating ?? 2;
    const result = {
      checkedAt: new Date().toISOString(),
      companiesHouse: company
        ? { state: company.found && company.active ? "OK" : company.found ? "INACTIVE" : "NOT_FOUND", ...company }
        : { state: app.companyNumber ? "NOT_CHECKED" : "NOT_GIVEN" },
      hygiene: hygiene
        ? { state: ratingBelowMinimum(hygiene.rating, minimum) ? "BELOW_MINIMUM" : "OK", minimum, ...hygiene }
        : { state: "NOT_FOUND", minimum },
    };
    await this.prisma.eflApplication.update({ where: { id }, data: { checks: result as any } });
    return result;
  }

  async list() {
    const rows = await this.prisma.eflApplication.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        status: true,
        businessName: true,
        city: true,
        createdAt: true,
        checks: true,
      },
    });
    return rows;
  }

  /** One application, with 10-minute links to its documents. */
  async get(id: string) {
    const app = await this.prisma.eflApplication.findUnique({ where: { id } });
    if (!app) throw new NotFoundException("Application not found");
    const [idDocUrl, bankDocUrl] = await Promise.all([
      app.idDocPath ? this.storage.signedUrl(app.idDocPath) : null,
      app.bankDocPath ? this.storage.signedUrl(app.bankDocPath) : null,
    ]);
    const { idDocPath, bankDocPath, ...rest } = app;
    return { ...rest, hasIdDocument: !!idDocPath, hasBankStatement: !!bankDocPath, idDocUrl, bankDocUrl };
  }

  async decide(
    id: string,
    decision: { status: "APPROVED" | "DECLINED" | "WAITING_INFO"; note?: string },
    decidedBy: string,
  ) {
    const app = await this.prisma.eflApplication.findUnique({ where: { id }, select: { id: true } });
    if (!app) throw new NotFoundException("Application not found");
    await this.prisma.eflApplication.update({
      where: { id },
      data: {
        status: decision.status,
        decisionNote: decision.note?.trim() || null,
        decidedAt: new Date(),
        decidedBy,
      },
    });
    return this.get(id);
  }
}
