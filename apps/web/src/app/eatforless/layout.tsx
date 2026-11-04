import type { Metadata, Viewport } from "next";
import { EflBaseProvider } from "@/components/eatforless/efl-base-context";
import { EflStyles } from "@/components/eatforless/efl-styles";
import { SiteFooter } from "@/components/eatforless/site-footer";
import { EFL_ORIGIN } from "@/lib/efl-site";
import { getEflBase } from "@/lib/efl-site.server";

const DESCRIPTION =
  "Order from your local takeaways for less. Same menus, lower prices, because shops pay us less. Launching in Newcastle and Tyne and Wear.";

export const metadata: Metadata = {
  metadataBase: new URL(EFL_ORIGIN),
  title: {
    default: "Eat For Less — local food delivery, for less",
    template: "%s · Eat For Less",
  },
  description: DESCRIPTION,
  applicationName: "Eat For Less",
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: "Eat For Less",
    locale: "en_GB",
    title: "Eat For Less — local food delivery, for less",
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary",
    title: "Eat For Less — local food delivery, for less",
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#FFFFFF",
};

export default async function EatForLessLayout({ children }: { children: React.ReactNode }) {
  const base = await getEflBase();
  return (
    <EflBaseProvider base={base}>
      <EflStyles />
      <div className="efl-root flex min-h-screen flex-col bg-white text-[#0B0B0B] antialiased">
        <div className="flex-1">{children}</div>
        <SiteFooter base={base} />
      </div>
    </EflBaseProvider>
  );
}
