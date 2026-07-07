// Phase AP-MARKETING follow-up — Privacy Notice page at /privacy.
//
// Lives at https://www.orderhubsolutions.com/privacy — the exact URL
// the operator added to Google Cloud Console's OAuth consent screen
// so Google's verification team can pull it during app review.
//
// Content authored by the operator; layout matches /terms via the
// shared LegalPage component so both URLs look like part of the same
// polished product.

import type { Metadata } from "next";
import {
  LegalPage,
  LegalList,
  LegalSubHeading,
  LegalBasis,
} from "@/components/marketing/legal-page";
import { getSiteBrand } from "@/lib/site-brand.server";

export async function generateMetadata(): Promise<Metadata> {
  const brand = await getSiteBrand();
  return {
    title: `Privacy Notice · ${brand.shortName}`,
    description: `How ${brand.shortName} collects, uses, and protects your personal data. Compliant with UK GDPR.`,
    // Allow indexing — Google's verification team uses the live page.
    robots: { index: true, follow: true },
  };
}

export default async function PrivacyPage() {
  const brand = await getSiteBrand();
  const name = brand.shortName;
  return (
    <LegalPage
      title="Privacy Notice"
      lede="How we collect, use, and protect your personal data when you interact with our website, platform, and services."
      lastUpdated="June 2026"
      preface={
        <>
          <p>
            {name} (&ldquo;{name}&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;,
            or &ldquo;our&rdquo;) is committed to protecting your personal data
            and processing it in a lawful, fair, and transparent manner.
          </p>
          <p className="mt-3">
            This Privacy Notice explains how we collect, use, and protect your
            personal data when you interact with our website, platform, and
            services. For the purpose of this Notice,{" "}
            <strong>personal data</strong> means any information that can
            identify you directly or indirectly, such as your name, email
            address, phone number, or business details.
          </p>
        </>
      }
      sections={[
        {
          id: "who-we-are",
          title: "Who We Are",
          body: (
            <>
              <p>
                {name} is a restaurant technology platform providing
                solutions including:
              </p>
              <LegalList
                items={[
                  "Online ordering systems",
                  "WhatsApp ordering",
                  "Delivery platform integrations",
                  "POS systems",
                  "Dispatch, driver management, and our driver mobile app",
                  "Menu and restaurant operations management",
                ]}
              />
              <p>
                We provide services to restaurants, takeaways, cafés, and food
                businesses.
              </p>
              <p className="mt-3">
                If you have any questions about this Privacy Notice, contact us
                at:{" "}
                <a
                  href="mailto:support@orderhubpos.com"
                  className="font-medium text-emerald-700 hover:underline"
                >
                  support@orderhubpos.com
                </a>
              </p>
            </>
          ),
        },
        {
          id: "how-we-use-data",
          title: "How We Use Your Personal Data",
          body: (
            <>
              <LegalSubHeading>I. Visiting Our Website</LegalSubHeading>
              <p>
                When you visit our website, you may provide personal data by
                booking a demo, requesting a quote, filling out contact forms,
                or subscribing to updates.
              </p>
              <p className="mt-2">
                We collect this data to respond to your enquiries, provide
                product information, and contact you about our services.
              </p>
              <LegalBasis>Consent and legitimate interest</LegalBasis>

              <LegalSubHeading>II. Demo Requests &amp; Lead Forms</LegalSubHeading>
              <p>
                When you submit a form, we collect: name, business name, email
                address, phone number, and business details.
              </p>
              <p className="mt-2">
                We use this data to contact you about your enquiry and provide
                a tailored solution.
              </p>
              <LegalBasis>Legitimate interest (business communication)</LegalBasis>

              <LegalSubHeading>III. Customer Relationship Management</LegalSubHeading>
              <p>
                If you are a customer, we process your data to provide access
                to the platform, manage your account, deliver support services,
                process billing and invoices, and notify you of updates.
              </p>
              <LegalBasis>Contract performance</LegalBasis>

              <LegalSubHeading>IV. Platform Usage Data</LegalSubHeading>
              <p>
                When using {name}, we may collect order data, menu data,
                delivery and dispatch data, and system activity to operate and
                improve our platform, provide analytics, and ensure system
                performance.
              </p>

              <LegalSubHeading>V. Communication &amp; Support</LegalSubHeading>
              <p>
                We may process your data when you contact support or
                communicate with us via email or chat to resolve issues and
                improve our services.
              </p>

              <LegalSubHeading>VI. Marketing Communications</LegalSubHeading>
              <p>
                We may send product updates, feature announcements, and
                promotional content. You can unsubscribe at any time.
              </p>
              <LegalBasis>Consent or legitimate interest</LegalBasis>

              <LegalSubHeading>VII. WhatsApp Ordering</LegalSubHeading>
              <p>
                When a customer places an order through our WhatsApp ordering
                channel, we process their WhatsApp phone number, the name shown
                on their WhatsApp profile, and the content of the messages
                exchanged with us (for example menu selections, delivery
                address, and order notes).
              </p>
              <p className="mt-2">
                We use this data only to take and fulfil the order, send order
                confirmations and order or payment status updates, and provide
                customer support. These messages are handled through the
                WhatsApp Business Platform provided by Meta Platforms, Inc.; we
                do <strong>not</strong> use WhatsApp message content for
                advertising or marketing. Where you order from a specific
                restaurant, we act as a processor on that restaurant&rsquo;s
                behalf.
              </p>
              <LegalBasis>
                Contract performance and legitimate interest
              </LegalBasis>

              <LegalSubHeading>
                VIII. Driver App, Dispatch &amp; Delivery Tracking
              </LegalSubHeading>
              <p>
                Our dispatch system and driver mobile app process information
                about drivers and deliveries. For drivers, this includes name
                and contact details and, while a driver is signed in and on an
                active shift or assigned to a delivery, their device&rsquo;s
                geographic location.
              </p>
              <p className="mt-2">
                We use location data to assign jobs, calculate routes and
                estimated arrival times, and allow restaurants and customers to
                track a delivery in real time. Location is collected only while
                the driver is on shift or has an active delivery &mdash; it is
                not used to monitor drivers outside of working time. We also
                process delivery details such as pickup and drop-off addresses,
                timestamps, and delivery status, and a customer awaiting a
                delivery may be shown the driver&rsquo;s approximate live
                location and estimated arrival time.
              </p>
              <LegalBasis>
                Contract performance and legitimate interest
              </LegalBasis>
            </>
          ),
        },
        {
          id: "retention",
          title: "How Long We Keep Your Data",
          body: (
            <p>
              We only keep your personal data as long as necessary to provide
              our services, comply with legal obligations, and resolve
              disputes. When no longer required, your data will be deleted or
              anonymised.
            </p>
          ),
        },
        {
          id: "sharing",
          title: "Sharing Your Personal Data",
          body: (
            <>
              <p className="font-semibold text-zinc-900">
                We do not sell your personal data.
              </p>

              <LegalSubHeading>I. Service Providers</LegalSubHeading>
              <p>
                We may share your data with trusted providers including cloud
                hosting providers, payment processors, communication tools, and
                analytics platforms. These providers process data on our behalf
                under strict agreements.
              </p>

              <LegalSubHeading>II. Delivery &amp; Integration Partners</LegalSubHeading>
              <p>
                To provide our services, we may connect with delivery platforms,
                POS systems, courier services, messaging providers (including the
                WhatsApp Business Platform provided by Meta, for WhatsApp
                ordering), and mapping and routing providers (such as Google
                Maps, for driver navigation and live delivery tracking). Data is
                only shared as necessary to deliver functionality.
              </p>

              <LegalSubHeading>III. Legal Requirements</LegalSubHeading>
              <p>
                We may disclose data if required to comply with legal
                obligations, protect our rights, or prevent fraud or misuse.
              </p>
            </>
          ),
        },
        {
          id: "security",
          title: "How We Protect Your Data",
          body: (
            <>
              <p>We implement strong security measures, including:</p>
              <LegalList
                items={[
                  "Encrypted data transmission",
                  "Secure cloud infrastructure",
                  "Access control systems",
                  "Regular security monitoring",
                ]}
              />
              <p>
                We take all reasonable steps to protect your data from loss,
                misuse, and unauthorised access.
              </p>
            </>
          ),
        },
        {
          id: "your-rights",
          title: "Your Rights",
          body: (
            <>
              <p>
                Under data protection laws (GDPR), you have the right to:
              </p>
              <div className="my-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[
                  ["Access", "Request a copy of your personal data"],
                  ["Correction", "Correct inaccurate or incomplete data"],
                  ["Deletion", "Request deletion of your data (where applicable)"],
                  ["Restriction", "Limit how your data is processed"],
                  ["Objection", "Object to processing based on legitimate interest"],
                  ["Data Portability", "Receive your data in a structured format"],
                  ["Withdraw Consent", "Withdraw consent at any time"],
                ].map(([h, sub]) => (
                  <div
                    key={h}
                    className="rounded-xl border border-zinc-100 bg-zinc-50/60 p-3"
                  >
                    <p className="text-sm font-semibold text-zinc-900">{h}</p>
                    <p className="mt-1 text-xs text-zinc-600">{sub}</p>
                  </div>
                ))}
              </div>
              <p>
                To exercise your rights, contact:{" "}
                <a
                  href="mailto:support@orderhubpos.com"
                  className="font-medium text-emerald-700 hover:underline"
                >
                  support@orderhubpos.com
                </a>
              </p>
            </>
          ),
        },
        {
          id: "cookies",
          title: "Cookies & Tracking Technologies",
          body: (
            <>
              <p>
                We use cookies to improve your experience. Cookies are small
                files stored on your device that help us understand website
                usage, improve performance, and provide relevant content.
              </p>
              <LegalSubHeading>Types of Cookies We Use</LegalSubHeading>
              <LegalList
                items={[
                  <>
                    <strong>Essential Cookies</strong> – required for website
                    functionality
                  </>,
                  <>
                    <strong>Performance Cookies</strong> – help us analyse
                    website usage
                  </>,
                  <>
                    <strong>Marketing Cookies</strong> – used to deliver
                    relevant advertising
                  </>,
                ]}
              />
              <p>You can control cookies through your browser settings.</p>
            </>
          ),
        },
        {
          id: "third-party",
          title: "Third-Party Tools",
          body: (
            <p>
              We may use tools such as Google Analytics, Meta (Facebook Ads),
              the WhatsApp Business Platform provided by Meta (for WhatsApp
              ordering), Google Maps (for driver navigation and live delivery
              tracking), payment processors such as Stripe, CRM systems, and
              customer support tools. These providers process data according to
              their own privacy policies.
            </p>
          ),
        },
        {
          id: "international",
          title: "International Data Transfers",
          body: (
            <p>
              Your data may be processed outside the UK or EU. When this
              happens, we ensure appropriate safeguards are in place.
            </p>
          ),
        },
        {
          id: "updates",
          title: "Updates to This Policy",
          body: (
            <p>
              We may update this Privacy Policy from time to time. We recommend
              checking this page regularly to stay informed.
            </p>
          ),
        },
        {
          id: "contact",
          title: "Contact Us",
          body: (
            <>
              <p>
                If you have any questions or concerns about this Privacy
                Notice, please contact:
              </p>
              <div className="my-3 space-y-2 rounded-xl bg-zinc-50/80 p-4">
                <p>
                  📧{" "}
                  <a
                    href="mailto:support@orderhubpos.com"
                    className="font-medium text-emerald-700 hover:underline"
                  >
                    support@orderhubpos.com
                  </a>
                </p>
                <p>
                  🌐{" "}
                  <a
                    href={`https://www.${brand.domain}`}
                    className="font-medium text-emerald-700 hover:underline"
                  >
                    www.{brand.domain}
                  </a>
                </p>
              </div>
            </>
          ),
        },
      ]}
    />
  );
}
