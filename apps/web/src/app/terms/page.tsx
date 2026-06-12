// Phase AP-MARKETING follow-up — Terms of Service page at /terms.
//
// Sibling of /privacy. Both URLs are referenced by Google Cloud
// Console's OAuth consent screen so Google's verification team can
// pull them during the app-review process.

import type { Metadata } from "next";
import {
  LegalPage,
  LegalList,
} from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service · Order Hub",
  description:
    "The terms under which Order Hub provides its restaurant technology platform.",
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      lede="The terms under which Order Hub provides its restaurant technology platform."
      lastUpdated="June 2026"
      preface={
        <>
          <p>
            Welcome to Order Hub (&ldquo;Order Hub&rdquo;, &ldquo;we&rdquo;,
            &ldquo;us&rdquo;, &ldquo;our&rdquo;), operated via{" "}
            <a
              href="https://www.orderhubsolutions.com"
              className="font-medium text-emerald-700 hover:underline"
            >
              www.orderhubsolutions.com
            </a>
            .
          </p>
          <p className="mt-3">
            By accessing or using our platform, you agree to these Terms of
            Service.
          </p>
        </>
      }
      sections={[
        {
          id: "our-services",
          title: "Our Services",
          body: (
            <>
              <p>
                Order Hub provides restaurant software solutions including:
              </p>
              <LegalList
                items={[
                  "Online ordering systems",
                  "Delivery integrations",
                  "POS systems",
                  "Dispatch and driver management",
                  "Menu and operations management",
                ]}
              />
              <p>
                These services are provided on a subscription or custom
                agreement basis.
              </p>
            </>
          ),
        },
        {
          id: "eligibility",
          title: "Eligibility",
          body: (
            <>
              <p>You must be:</p>
              <LegalList
                items={[
                  "At least 18 years old",
                  "Operating a business or authorised to act on behalf of one",
                ]}
              />
            </>
          ),
        },
        {
          id: "account",
          title: "Account Responsibilities",
          body: (
            <>
              <p>You agree to:</p>
              <LegalList
                items={[
                  "Provide accurate information",
                  "Keep login credentials secure",
                  "Be responsible for all activity on your account",
                ]}
              />
            </>
          ),
        },
        {
          id: "use",
          title: "Use of the Platform",
          body: (
            <>
              <p>You agree not to:</p>
              <LegalList
                items={[
                  "Use the platform for illegal purposes",
                  "Interfere with system security",
                  "Attempt to reverse engineer the software",
                ]}
              />
            </>
          ),
        },
        {
          id: "payments",
          title: "Payments & Pricing",
          body: (
            <LegalList
              items={[
                "Pricing is provided via custom quotes",
                "Payments may be subscription-based or agreed separately",
                "Failure to pay may result in suspension of services",
              ]}
            />
          ),
        },
        {
          id: "integrations",
          title: "Integrations",
          body: (
            <>
              <p>
                Order Hub integrates with third-party platforms (e.g., delivery
                providers).
              </p>
              <p className="mt-2">We are not responsible for:</p>
              <LegalList
                items={[
                  "Downtime of third-party services",
                  "Changes made by third-party platforms",
                ]}
              />
            </>
          ),
        },
        {
          id: "data",
          title: "Data & Ownership",
          body: (
            <LegalList
              items={[
                "You retain ownership of your business data",
                "You grant us permission to process it to provide services",
              ]}
            />
          ),
        },
        {
          id: "termination",
          title: "Termination",
          body: (
            <>
              <p>We may suspend or terminate access if:</p>
              <LegalList
                items={[
                  "Terms are violated",
                  "Payments are overdue",
                  "Misuse of the system occurs",
                ]}
              />
            </>
          ),
        },
        {
          id: "liability",
          title: "Liability",
          body: (
            <>
              <p>Order Hub is not liable for:</p>
              <LegalList
                items={[
                  "Loss of revenue",
                  "Third-party failures",
                  "Indirect or consequential damages",
                ]}
              />
            </>
          ),
        },
        {
          id: "changes",
          title: "Changes",
          body: (
            <p>
              We may update these Terms at any time. Continued use means
              acceptance.
            </p>
          ),
        },
        {
          id: "contact",
          title: "Contact",
          body: (
            <div className="my-3 space-y-2 rounded-xl bg-zinc-50/80 p-4">
              <p>
                📧{" "}
                <a
                  href="mailto:support@orderhubsolutions.com"
                  className="font-medium text-emerald-700 hover:underline"
                >
                  support@orderhubsolutions.com
                </a>
              </p>
              <p>
                🌐{" "}
                <a
                  href="https://www.orderhubsolutions.com"
                  className="font-medium text-emerald-700 hover:underline"
                >
                  www.orderhubsolutions.com
                </a>
              </p>
            </div>
          ),
        },
      ]}
    />
  );
}
