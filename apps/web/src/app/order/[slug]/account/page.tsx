"use client";

// My account — the customer's own details, kept on their account so checkout
// on any of our storefronts starts filled in: phone, a saved delivery address,
// and (optionally) a date of birth for birthday offers.
//
// The same details are also saved from checkout's "Save my details" box; this
// page is where a customer sees and changes them.

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Loader2, Trash2, UserRound } from "lucide-react";
import { useCustomerAuth, type CustomerProfilePatch } from "@/hooks/use-customer-auth";
import { LoginModal } from "@/components/storefront/login-modal";
import { StorefrontTabBar } from "@/components/storefront/tab-bar";
import { PoweredByOrderHub } from "@/components/storefront/powered-by";

export default function AccountPage() {
  return (
    <Suspense fallback={<div className="sf-root min-h-screen" />}>
      <AccountInner />
    </Suspense>
  );
}

type Form = {
  firstName: string;
  lastName: string;
  phone: string;
  dateOfBirth: string;
  addressLine2: string;
  addressLine1: string;
  addressCity: string;
  addressPostcode: string;
  addressArea: string;
};

const EMPTY: Form = {
  firstName: "",
  lastName: "",
  phone: "",
  dateOfBirth: "",
  addressLine2: "",
  addressLine1: "",
  addressCity: "",
  addressPostcode: "",
  addressArea: "",
};

const today = () => new Date().toISOString().slice(0, 10);

function AccountInner() {
  const { slug } = useParams<{ slug: string }>();
  const brandId = useSearchParams()?.get("brand") ?? null;
  const brandSuffix = brandId ? `?brand=${encodeURIComponent(brandId)}` : "";
  const { customer, isLoading, updateProfile, deleteAccount } = useCustomerAuth();
  const [form, setForm] = useState<Form>(EMPTY);
  const [loginOpen, setLoginOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Deleting signs the customer out; without this the page would greet them
  // with a sign-in box a moment after they asked to leave.
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    if (!isLoading && !customer && !deleted) setLoginOpen(true);
  }, [isLoading, customer, deleted]);

  // Load the account into the form once, when it arrives.
  const customerId = customer?.id;
  useEffect(() => {
    if (!customer) return;
    setForm({
      firstName: customer.firstName ?? "",
      lastName: customer.lastName ?? "",
      phone: customer.phone ?? "",
      dateOfBirth: customer.dateOfBirth ?? "",
      addressLine2: customer.addressLine2 ?? "",
      addressLine1: customer.addressLine1 ?? "",
      addressCity: customer.addressCity ?? "",
      addressPostcode: customer.addressPostcode ?? "",
      addressArea: customer.addressArea ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.firstName.trim() || !form.lastName.trim()) {
      setError("Please enter your first and last name.");
      return;
    }
    setSaving(true);
    setError(null);
    const orNull = (v: string) => v.trim() || null;
    const patch: CustomerProfilePatch = {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      phone: orNull(form.phone),
      dateOfBirth: orNull(form.dateOfBirth),
      addressLine1: orNull(form.addressLine1),
      addressLine2: orNull(form.addressLine2),
      addressCity: orNull(form.addressCity),
      addressPostcode: orNull(form.addressPostcode),
      addressArea: orNull(form.addressArea),
    };
    try {
      await updateProfile(patch);
      setSaved(true);
    } catch (err: any) {
      const msg = err?.response?.data?.message;
      setError(Array.isArray(msg) ? msg.join(" ") : (msg ?? "Couldn't save. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sf-root min-h-screen">
      <header className="sticky top-0 z-40 h-16 border-b border-sf-border bg-sf-surface">
        <div className="mx-auto flex h-full max-w-2xl items-center gap-2 px-2">
          <Link
            href={`/order/${slug}${brandSuffix}`}
            aria-label="Back to the menu"
            className="grid h-11 w-11 place-items-center rounded-full text-sf-text hover:bg-sf-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </Link>
          <h1 className="text-[17px] font-semibold text-sf-text">My account</h1>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-6">
        {deleted ? (
          <p role="status" className="rounded-2xl border border-sf-border bg-sf-surface p-4 text-sm text-sf-text">
            Your account has been deleted. Thanks for ordering with us.
          </p>
        ) : isLoading ? (
          <div className="grid place-items-center py-24" role="status">
            <Loader2 className="h-6 w-6 animate-spin text-sf-muted" aria-hidden />
            <span className="sr-only">Loading your account…</span>
          </div>
        ) : !customer ? (
          <div className="flex flex-col items-center py-20 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-full bg-sf-raised text-sf-muted">
              <UserRound className="h-6 w-6" aria-hidden />
            </span>
            <p className="mt-4 text-base font-semibold text-sf-text">Sign in to see your account</p>
            <button
              type="button"
              onClick={() => setLoginOpen(true)}
              className="mt-4 inline-flex min-h-[48px] items-center rounded-xl bg-sf-cta px-6 text-[15px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent focus-visible:ring-offset-2"
            >
              Sign in
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-6" noValidate>
            <p className="text-sm text-sf-muted">
              Signed in as <span className="font-medium text-sf-text">{customer.email}</span>.
              Saved details fill in checkout for you next time.
            </p>

            <Card title="Your details">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="First name" autoComplete="given-name" value={form.firstName} onChange={set("firstName")} required />
                <Field label="Last name" autoComplete="family-name" value={form.lastName} onChange={set("lastName")} required />
              </div>
              <Field label="Phone number" type="tel" autoComplete="tel" value={form.phone} onChange={set("phone")} />
              <Field
                label="Date of birth (optional)"
                type="date"
                autoComplete="bday"
                max={today()}
                min="1900-01-01"
                value={form.dateOfBirth}
                onChange={set("dateOfBirth")}
                hint="So we can send you a treat on your birthday, if you've said yes to offers."
              />
            </Card>

            <Card title="Delivery address">
              <Field label="Flat / house number" autoComplete="address-line2" value={form.addressLine2} onChange={set("addressLine2")} />
              <Field label="Street" autoComplete="address-line1" value={form.addressLine1} onChange={set("addressLine1")} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Town / city" autoComplete="address-level2" value={form.addressCity} onChange={set("addressCity")} />
                <Field label="Postcode" autoComplete="postal-code" value={form.addressPostcode} onChange={set("addressPostcode")} />
              </div>
              <Field
                label="Area (optional)"
                value={form.addressArea}
                onChange={set("addressArea")}
                hint="Only needed where the shop delivers by area rather than postcode."
              />
            </Card>

            {error && (
              <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </p>
            )}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-sf-cta px-6 text-[15px] font-semibold text-white transition-[filter,transform] hover:brightness-110 active:scale-[0.98] disabled:opacity-60 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent focus-visible:ring-offset-2 focus-visible:ring-offset-sf-bg"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                Save details
              </button>
              <p aria-live="polite" className="text-sm text-sf-muted">
                {saved && (
                  <span className="inline-flex items-center gap-1 text-emerald-600">
                    <Check className="h-4 w-4" aria-hidden /> Saved
                  </span>
                )}
              </p>
            </div>

            <DeleteAccount
              onDelete={async (confirm) => {
                await deleteAccount(confirm);
                setDeleted(true);
              }}
            />
          </form>
        )}
      </main>

      <LoginModal
        open={loginOpen}
        storeSlug={String(slug)}
        brandId={brandId}
        onClose={() => setLoginOpen(false)}
        onAuthenticated={() => setLoginOpen(false)}
      />
      <PoweredByOrderHub />
      <StorefrontTabBar slug={String(slug)} brandId={brandId} />
    </div>
  );
}

/**
 * App Store guideline 5.1.1(v): customers who can create an account in the
 * app must be able to delete it there too. Two steps and a typed word, so a
 * mis-tap can't cost someone their loyalty stamps.
 */
const DeleteAccount = ({ onDelete }: { onDelete: (confirm: string) => Promise<void> }) => {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete(typed);
    } catch (err: any) {
      const msg = err?.response?.data?.message;
      setError(Array.isArray(msg) ? msg.join(" ") : (msg ?? "Couldn't delete your account. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-sf-border bg-sf-surface p-4 sm:p-5">
      <h2 className="text-base font-semibold text-sf-text">Delete my account</h2>
      {!open ? (
        <>
          <p className="mt-1 text-sm text-sf-muted">
            Removes your login, saved details, address and loyalty stamps. This can&rsquo;t be undone.
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-red-300 px-4 text-sm font-semibold text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          >
            <Trash2 className="h-4 w-4" aria-hidden /> Delete my account
          </button>
        </>
      ) : (
        <div className="mt-2 space-y-3">
          <p className="text-sm text-sf-text">
            Your past orders stay with the restaurant for their records, but they won&rsquo;t be linked to you any more.
            Type <strong>DELETE</strong> to confirm.
          </p>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Type DELETE to confirm"
            autoCapitalize="characters"
            autoComplete="off"
            className="h-12 w-full rounded-xl border border-sf-border bg-sf-bg px-3.5 text-[16px] text-sf-text focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          />
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || typed.trim().toUpperCase() !== "DELETE"}
              onClick={confirm}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Delete permanently
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setTyped("");
                setError(null);
              }}
              className="inline-flex min-h-[44px] items-center rounded-xl border border-sf-border px-4 text-sm font-medium text-sf-text hover:bg-sf-raised"
            >
              Keep my account
            </button>
          </div>
        </div>
      )}
    </section>
  );
};

const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="space-y-3 rounded-2xl border border-sf-border bg-sf-surface p-4 sm:p-5">
    <h2 className="text-base font-semibold text-sf-text">{title}</h2>
    {children}
  </section>
);

type FieldProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
};

const Field = ({ label, hint, id, ...input }: FieldProps) => {
  const fieldId = id ?? `f-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div>
      <label htmlFor={fieldId} className="mb-1 block text-[13px] font-medium text-sf-text">
        {label}
      </label>
      <input
        id={fieldId}
        aria-describedby={hint ? `${fieldId}-hint` : undefined}
        className="h-12 w-full rounded-xl border border-sf-border bg-sf-bg px-3.5 text-[16px] text-sf-text placeholder:text-sf-muted focus:border-sf-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent"
        {...input}
      />
      {hint && (
        <p id={`${fieldId}-hint`} className="mt-1 text-xs text-sf-muted">
          {hint}
        </p>
      )}
    </div>
  );
};
