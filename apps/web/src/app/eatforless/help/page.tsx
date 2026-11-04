import type { Metadata } from "next";
import { HelpContent } from "@/components/eatforless/legal/help-content";
import { LegalPage } from "@/components/eatforless/legal/legal-page";
import { getEflBase } from "@/lib/efl-site.server";

export const metadata: Metadata = {
  title: "Help",
  description: "Answers about ordering, delivery, allergies and your Eat For Less account.",
  alternates: { canonical: "/help" },
};

export default async function Page() {
  const base = await getEflBase();
  return (
    <LegalPage base={base} title="Help" intro="Quick answers to the questions we get most.">
      <HelpContent />
    </LegalPage>
  );
}
