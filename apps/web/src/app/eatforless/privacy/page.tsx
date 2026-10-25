import type { Metadata } from "next";
import { LegalPage } from "@/components/eatforless/legal/legal-page";
import { PrivacyContent } from "@/components/eatforless/legal/privacy-content";
import { getEflBase } from "@/lib/efl-site.server";

export const metadata: Metadata = {
  title: "Privacy",
  description: "How Eat For Less collects, uses and protects your personal data.",
  alternates: { canonical: "/privacy" },
};

export default async function Page() {
  const base = await getEflBase();
  return (
    <LegalPage
      base={base}
      draft
      title="Privacy notice"
      intro="What we collect when you use Eat For Less, why, and the choices you have."
      updated="25 October 2026"
    >
      <PrivacyContent />
    </LegalPage>
  );
}
