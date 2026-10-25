"use client";

// The 4-step "Partner with Eat For Less" application. Each step is checked
// before Continue; the last one sends everything to POST /v1/efl/applications
// and swaps the card for the "Application sent" state with the reference.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { eflPartnerClient, type EflApplicationInput } from "@/lib/api/efl.client";
import { FileDrop, SelectField, TextField } from "./partner-fields";
import { DOC_TOO_BIG, DocumentError, MAX_DOC_BYTES, prepareDocument, type PreparedDoc } from "./partner-documents";

const CUISINES = ["Pizza", "Kebab", "Burgers", "Indian", "Chicken", "Chinese", "Fast food", "Desserts", "Other"] as const;

const STEP_NAMES = ["Your business", "About you", "Menu and hygiene", "Documents"] as const;

type TextKey =
  | "businessName"
  | "companyNumber"
  | "cuisine"
  | "addressLine1"
  | "city"
  | "postcode"
  | "firstName"
  | "lastName"
  | "phone"
  | "email"
  | "menuUrl"
  | "hygieneUrl";
type DocKey = "idDocument" | "bankStatement";
type FieldKey = TextKey | DocKey;
type Errors = Partial<Record<FieldKey, string>>;

const STEP_FIELDS: readonly (readonly FieldKey[])[] = [
  ["businessName", "companyNumber", "cuisine", "addressLine1", "city", "postcode"],
  ["firstName", "lastName", "phone", "email"],
  ["menuUrl", "hygieneUrl"],
  ["idDocument", "bankStatement"],
];

const EMPTY: Record<TextKey, string> = {
  businessName: "",
  companyNumber: "",
  cuisine: "",
  addressLine1: "",
  city: "",
  postcode: "",
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  menuUrl: "",
  hygieneUrl: "",
};

const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const MOBILE_RE = /^(?:\+44|0044|0)7\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const COMPANY_RE = /^[A-Z0-9]{1,8}$/i;

/** Adds https:// when someone pastes "justeat.co.uk/…" and returns null when it isn't a web link. */
function normaliseUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    return url.hostname.includes(".") ? url.toString() : null;
  } catch {
    return null;
  }
}

function validateStep(step: number, v: Record<TextKey, string>, docs: Partial<Record<DocKey, PreparedDoc>>): Errors {
  const e: Errors = {};
  if (step === 0) {
    if (!v.businessName.trim()) e.businessName = "Enter your business name.";
    const company = v.companyNumber.replace(/\s+/g, "");
    if (company && !COMPANY_RE.test(company)) e.companyNumber = "A company number is up to 8 letters and numbers.";
    if (!v.addressLine1.trim()) e.addressLine1 = "Enter the shop's street address.";
    if (!v.city.trim()) e.city = "Enter the town or city.";
    if (!v.postcode.trim()) e.postcode = "Enter the shop's postcode.";
    else if (!POSTCODE_RE.test(v.postcode.trim())) e.postcode = "Enter a UK postcode, like SW1A 1AA.";
  }
  if (step === 1) {
    if (!v.firstName.trim()) e.firstName = "Enter your first name.";
    if (!v.lastName.trim()) e.lastName = "Enter your surname.";
    const phone = v.phone.replace(/[\s\-().]/g, "");
    if (!phone) e.phone = "Enter your mobile number.";
    else if (!MOBILE_RE.test(phone)) e.phone = "Enter a UK mobile number, like 07700 900123.";
    if (!v.email.trim()) e.email = "Enter your email address.";
    else if (!EMAIL_RE.test(v.email.trim())) e.email = "Enter an email address, like name@example.com.";
  }
  if (step === 2) {
    if (v.menuUrl.trim() && !normaliseUrl(v.menuUrl)) e.menuUrl = "Paste the full web link to your menu page.";
    if (v.hygieneUrl.trim()) {
      const url = normaliseUrl(v.hygieneUrl);
      if (!url || !new URL(url).hostname.endsWith("food.gov.uk")) {
        e.hygieneUrl = "Paste the link from ratings.food.gov.uk, or leave this blank.";
      }
    }
  }
  if (step === 3) {
    if (!docs.idDocument) e.idDocument = "Add a photo of your passport or driving licence.";
    if (!docs.bankStatement) e.bankStatement = "Add a recent bank statement.";
  }
  return e;
}

function buildInput(v: Record<TextKey, string>, docs: Partial<Record<DocKey, PreparedDoc>>): EflApplicationInput {
  const optional = (s: string) => s.trim() || undefined;
  return {
    businessName: v.businessName.trim(),
    companyNumber: optional(v.companyNumber.replace(/\s+/g, "").toUpperCase()),
    cuisine: optional(v.cuisine),
    addressLine1: v.addressLine1.trim(),
    city: v.city.trim(),
    postcode: v.postcode.trim().toUpperCase(),
    firstName: v.firstName.trim(),
    lastName: v.lastName.trim(),
    phone: v.phone.trim(),
    email: v.email.trim(),
    menuUrl: normaliseUrl(v.menuUrl) ?? undefined,
    hygieneUrl: normaliseUrl(v.hygieneUrl) ?? undefined,
    idDocument: docs.idDocument?.dataUrl,
    bankStatement: docs.bankStatement?.dataUrl,
  };
}

function apiErrorMessage(err: unknown): string {
  const res = (err as { response?: { status?: number; data?: { message?: unknown } } })?.response;
  if (res?.status === 429) return "Too many attempts. Please wait a minute and try again.";
  if (res?.status === 413) return DOC_TOO_BIG;
  const msg = res?.data?.message;
  if (Array.isArray(msg)) {
    const parts = msg.filter((m): m is string => typeof m === "string");
    if (parts.length) return parts.join(" ");
  }
  if (typeof msg === "string" && msg.trim()) return msg;
  if (!res) return "We couldn't reach Eat For Less. Check your connection and try again.";
  return "Something went wrong. Please try again.";
}

export function PartnerApplyForm() {
  const [step, setStep] = useState(0);
  const [values, setValues] = useState(EMPTY);
  const [docs, setDocs] = useState<Partial<Record<DocKey, PreparedDoc>>>({});
  const [busyDoc, setBusyDoc] = useState<DocKey | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [stepError, setStepError] = useState<string | null>(null);

  const fieldRefs = useRef<Partial<Record<FieldKey, HTMLInputElement | HTMLSelectElement | null>>>({});
  const headingRef = useRef<HTMLHeadingElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const movedRef = useRef(false);

  const apply = useMutation({
    mutationFn: (input: EflApplicationInput) => eflPartnerClient.apply(input),
    retry: false,
  });

  const done = apply.isSuccess;

  // After Continue/Back, move focus to the new step's heading so screen
  // readers announce it and keyboard users start at the top of the step.
  useEffect(() => {
    if (!movedRef.current) return;
    headingRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const refFor = (key: FieldKey) => (el: HTMLInputElement | HTMLSelectElement | null) => {
    fieldRefs.current[key] = el;
  };

  const set = (key: TextKey) => (value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const pickDoc = async (key: DocKey, file: File) => {
    setBusyDoc(key);
    setStepError(null);
    try {
      const prepared = await prepareDocument(file);
      setDocs((d) => ({ ...d, [key]: prepared }));
      setErrors((e) => ({ ...e, [key]: undefined }));
    } catch (err) {
      const message = err instanceof DocumentError ? err.message : "We couldn't read that file. Please try another.";
      setDocs((d) => ({ ...d, [key]: undefined }));
      // The size message goes on the step (the banner); the zone just says which file.
      const tooBig = message === DOC_TOO_BIG;
      setErrors((e) => ({ ...e, [key]: tooBig ? "This file is over 3.5 MB." : message }));
      if (tooBig) setStepError(DOC_TOO_BIG);
    } finally {
      setBusyDoc(null);
    }
  };

  const focusFirstInvalid = (found: Errors) => {
    const first = STEP_FIELDS[step]?.find((k) => found[k]);
    if (first) fieldRefs.current[first]?.focus();
  };

  const go = (next: number) => {
    movedRef.current = true;
    setErrors({});
    setStepError(null);
    apply.reset();
    setStep(next);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (apply.isPending || busyDoc) return;
    const found = validateStep(step, values, docs);
    if (Object.values(found).some(Boolean)) {
      setErrors(found);
      focusFirstInvalid(found);
      return;
    }
    if (step < 3) {
      go(step + 1);
      return;
    }
    // Belt and braces: never send a document the API will refuse.
    if (Object.values(docs).some((d) => d && d.bytes > MAX_DOC_BYTES)) {
      setStepError(DOC_TOO_BIG);
      return;
    }
    setStepError(null);
    apply.mutate(buildInput(values, docs));
  };

  if (done) {
    return (
      <div className="flex flex-col items-center gap-3.5 py-6 text-center sm:py-8" role="status">
        <span className="efl-ok flex h-24 w-24 items-center justify-center rounded-full bg-[#D4FF3F]">
          <svg aria-hidden="true" width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="#0B0B0B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path className="efl-tick" d="M5 12l5 5 9-10" />
          </svg>
        </span>
        <h2 ref={doneRef} tabIndex={-1} className="m-0 text-[28px] font-extrabold tracking-tight focus:outline-none">
          Application sent
        </h2>
        <p className="m-0 max-w-[440px] text-[15px] leading-normal text-[#5E5E5E]">
          We&apos;re checking your details and food hygiene rating now. You&apos;ll hear from us by email and text,
          usually within 2 working days.
        </p>
        <p className="m-0 rounded-xl bg-[#F3F3F3] px-4 py-2.5 text-sm font-semibold">
          Reference: <span className="font-mono font-bold tracking-wider">{apply.data.reference}</span>
        </p>
      </div>
    );
  }

  const apiError = apply.isError ? apiErrorMessage(apply.error) : null;
  const banner = stepError ?? apiError;
  const sending = apply.isPending;

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-[22px]" aria-busy={sending || undefined}>
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 ref={headingRef} tabIndex={-1} className="m-0 text-[13px] font-bold focus:outline-none">
            Step {step + 1} of 4 · {STEP_NAMES[step]}
          </h2>
          <span className="text-[13px] font-bold text-[#5E5E5E]">About 5 minutes</span>
        </div>
        <div
          role="progressbar"
          aria-label="Application progress"
          aria-valuemin={1}
          aria-valuemax={4}
          aria-valuenow={step + 1}
          aria-valuetext={`Step ${step + 1} of 4`}
          className="h-1.5 overflow-hidden rounded-[3px] bg-[#EFEFEC]"
        >
          <span className="efl-bar block h-full rounded-[3px] bg-[#0B0B0B]" style={{ width: `${(step + 1) * 25}%` }} />
        </div>
      </div>

      {step === 0 && (
        <fieldset key="s1" className="efl-step m-0 grid min-w-0 grid-cols-1 gap-4 border-0 p-0 sm:grid-cols-2">
          <legend className="sr-only">Your business</legend>
          <TextField
            ref={refFor("businessName")}
            id="businessName"
            label="Business name"
            placeholder="As on Companies House"
            autoComplete="organization"
            maxLength={120}
            value={values.businessName}
            onChange={set("businessName")}
            error={errors.businessName}
            className="sm:col-span-2"
          />
          <TextField
            ref={refFor("companyNumber")}
            id="companyNumber"
            label="Company number"
            optional
            placeholder="8 letters or numbers"
            autoCapitalize="characters"
            maxLength={12}
            value={values.companyNumber}
            onChange={set("companyNumber")}
            error={errors.companyNumber}
          />
          <SelectField
            ref={refFor("cuisine")}
            id="cuisine"
            label="Cuisine"
            optional
            placeholder="Choose a cuisine"
            options={CUISINES}
            value={values.cuisine}
            onChange={set("cuisine")}
            error={errors.cuisine}
          />
          <TextField
            ref={refFor("addressLine1")}
            id="addressLine1"
            label="Shop address"
            placeholder="Street address"
            autoComplete="address-line1"
            maxLength={160}
            value={values.addressLine1}
            onChange={set("addressLine1")}
            error={errors.addressLine1}
            className="sm:col-span-2"
          />
          <TextField
            ref={refFor("city")}
            id="city"
            label="Town or city"
            autoComplete="address-level2"
            maxLength={80}
            value={values.city}
            onChange={set("city")}
            error={errors.city}
          />
          <TextField
            ref={refFor("postcode")}
            id="postcode"
            label="Postcode"
            placeholder="SW1A 1AA"
            autoComplete="postal-code"
            autoCapitalize="characters"
            maxLength={10}
            value={values.postcode}
            onChange={set("postcode")}
            error={errors.postcode}
          />
        </fieldset>
      )}

      {step === 1 && (
        <fieldset key="s2" className="efl-step m-0 grid min-w-0 grid-cols-1 gap-4 border-0 p-0 sm:grid-cols-2">
          <legend className="sr-only">About you</legend>
          <TextField
            ref={refFor("firstName")}
            id="firstName"
            label="First name"
            autoComplete="given-name"
            maxLength={60}
            value={values.firstName}
            onChange={set("firstName")}
            error={errors.firstName}
          />
          <TextField
            ref={refFor("lastName")}
            id="lastName"
            label="Surname"
            autoComplete="family-name"
            maxLength={60}
            value={values.lastName}
            onChange={set("lastName")}
            error={errors.lastName}
          />
          <TextField
            ref={refFor("phone")}
            id="phone"
            label="Mobile"
            type="tel"
            inputMode="tel"
            placeholder="07700 900123"
            autoComplete="tel"
            maxLength={32}
            value={values.phone}
            onChange={set("phone")}
            error={errors.phone}
          />
          <TextField
            ref={refFor("email")}
            id="email"
            label="Email"
            type="email"
            inputMode="email"
            placeholder="name@example.com"
            autoComplete="email"
            autoCapitalize="none"
            maxLength={160}
            value={values.email}
            onChange={set("email")}
            error={errors.email}
          />
        </fieldset>
      )}

      {step === 2 && (
        <fieldset key="s3" className="efl-step m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
          <legend className="sr-only">Menu and hygiene</legend>
          <TextField
            ref={refFor("menuUrl")}
            id="menuUrl"
            label="Link to your menu"
            optional
            type="url"
            inputMode="url"
            autoCapitalize="none"
            placeholder="Your Just Eat, Deliveroo, Uber Eats or website page"
            hint="We copy your menu across for you. You can edit it before going live."
            maxLength={500}
            value={values.menuUrl}
            onChange={set("menuUrl")}
            error={errors.menuUrl}
          />
          <TextField
            ref={refFor("hygieneUrl")}
            id="hygieneUrl"
            label="Food hygiene rating link"
            optional
            type="url"
            inputMode="url"
            autoCapitalize="none"
            placeholder="ratings.food.gov.uk/business/…"
            hint="Shops need a food hygiene rating of 2 or more. We check it automatically."
            maxLength={500}
            value={values.hygieneUrl}
            onChange={set("hygieneUrl")}
            error={errors.hygieneUrl}
          />
        </fieldset>
      )}

      {step === 3 && (
        <fieldset key="s4" className="efl-step m-0 grid min-w-0 grid-cols-1 gap-4 border-0 p-0 sm:grid-cols-2">
          <legend className="sr-only">Documents</legend>
          <FileDrop
            ref={refFor("idDocument")}
            id="idDocument"
            title="Photo ID"
            hint="Passport or driving licence"
            fileName={docs.idDocument?.name}
            busy={busyDoc === "idDocument"}
            error={errors.idDocument}
            onPick={(f) => void pickDoc("idDocument", f)}
          />
          <FileDrop
            ref={refFor("bankStatement")}
            id="bankStatement"
            title="Bank statement"
            hint="From the last 3 months, showing the business name"
            fileName={docs.bankStatement?.name}
            busy={busyDoc === "bankStatement"}
            error={errors.bankStatement}
            onPick={(f) => void pickDoc("bankStatement", f)}
          />
          <p className="m-0 flex items-center gap-1.5 text-xs text-[#5E5E5E] sm:col-span-2">
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="3" y="7" width="10" height="7" rx="1.5" />
              <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
            </svg>
            PDF, JPG or PNG. Stored encrypted and seen only by the Eat For Less onboarding team.
          </p>
        </fieldset>
      )}

      {banner && (
        <div role="alert" className="rounded-xl border border-[#F3C3BE] bg-[#FEF3F2] px-4 py-3 text-sm font-semibold text-[#B42318]">
          {banner}
        </div>
      )}

      <div className="flex items-center gap-2.5">
        {step > 0 && (
          <button
            type="button"
            onClick={() => go(step - 1)}
            disabled={sending}
            className="efl-press h-[50px] rounded-[14px] bg-[#F3F3F3] px-5 text-[15px] font-bold text-[#0B0B0B] hover:bg-[#E9E9E7] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0B0B0B] disabled:opacity-50"
          >
            Back
          </button>
        )}
        <button
          type="submit"
          disabled={sending || busyDoc !== null}
          className="efl-press ml-auto inline-flex h-[50px] flex-1 items-center justify-center gap-2 rounded-[14px] bg-[#0B0B0B] px-[26px] text-[15px] font-extrabold text-white hover:bg-[#262626] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0B0B0B] disabled:cursor-not-allowed disabled:opacity-70 sm:flex-none"
        >
          {sending && (
            <svg aria-hidden="true" className="efl-spin h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <path d="M12 3a9 9 0 109 9" strokeLinecap="round" />
            </svg>
          )}
          {sending ? "Sending…" : step === 3 ? "Send application" : "Continue"}
        </button>
      </div>
    </form>
  );
}
