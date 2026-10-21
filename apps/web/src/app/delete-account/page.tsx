// Public "how to delete your account" page at /delete-account.
//
// Google Play requires every app that lets people create an account to link a
// public page (no sign-in needed to read it) explaining how to delete the
// account and what is deleted or kept. Every restaurant app built on OrderHub
// links here from its Play Store Data safety section.

import type { Metadata } from "next";
import { LegalPage, LegalList } from "@/components/marketing/legal-page";
import { getSiteBrand } from "@/lib/site-brand.server";

export async function generateMetadata(): Promise<Metadata> {
  const brand = await getSiteBrand();
  return {
    title: `Delete your account · ${brand.shortName}`,
    description: `How to delete your customer account in a restaurant app or online shop powered by ${brand.shortName}, and what happens to your data.`,
    robots: { index: true, follow: true },
  };
}

export default async function DeleteAccountPage() {
  const brand = await getSiteBrand();
  const name = brand.shortName;
  return (
    <LegalPage
      title="Delete your account"
      lede={`How to delete the customer account you use in restaurant apps and online shops powered by ${name}, such as Kingston Pizza and Pizza Uno Pelton.`}
      lastUpdated="October 2026"
      sections={[
        {
          id: "in-the-app",
          title: "Delete it yourself in the app",
          body: (
            <LegalList
              items={[
                "Open the restaurant's app (or its online shop) and sign in.",
                "Go to My account.",
                "Scroll to the bottom and tap Delete my account.",
                "Type DELETE to confirm, then tap Delete permanently.",
              ]}
            />
          ),
        },
        {
          id: "by-email",
          title: "Or ask us to delete it",
          body: (
            <p>
              Email <a href="mailto:omid@orderhubpos.com">omid@orderhubpos.com</a> from the email
              address on your account with the subject &ldquo;Delete my account&rdquo;. We delete it
              within 30 days and confirm by email.
            </p>
          ),
        },
        {
          id: "what-is-deleted",
          title: "What is deleted",
          body: (
            <LegalList
              items={[
                "Your login (email and password, or your Google sign-in link)",
                "Your saved name, phone number, delivery address and date of birth",
                "Your loyalty stamps, rewards and referral codes",
                "Your app notification settings, including offers",
              ]}
            />
          ),
        },
        {
          id: "what-is-kept",
          title: "What is kept, and for how long",
          body: (
            <p>
              Records of orders you placed stay with the restaurant you ordered from, no longer linked to
              your account, because restaurants must keep sales records for tax and accounting (normally
              six years under UK law). They are not used to contact you.
            </p>
          ),
        },
      ]}
    />
  );
}
