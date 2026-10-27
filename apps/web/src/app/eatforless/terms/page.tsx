import type { Metadata } from "next";
import { LegalPage } from "@/components/eatforless/legal/legal-page";
import { TermsContent } from "@/components/eatforless/legal/terms-content";
import { getEflBase } from "@/lib/efl-site.server";

export const metadata: Metadata = {
  title: "Terms",
  description: "The terms for using the Eat For Less website and app.",
  alternates: { canonical: "/terms" },
};

export default async function Page() {
  const base = await getEflBase();
  return (
    <LegalPage
      base={base}
      draft
      title="Terms of use"
      intro="The plain-English rules for ordering through Eat For Less."
      updated="25 October 2026"
    >
      <TermsContent />
    </LegalPage>
  );
}
