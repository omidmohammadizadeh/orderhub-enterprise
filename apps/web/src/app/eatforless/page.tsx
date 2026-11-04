import type { Metadata } from "next";
import { LandingPage } from "@/components/eatforless/landing/landing-page";
import { getEflBase } from "@/lib/efl-site.server";

export const metadata: Metadata = {
  // absolute: the root layout's "· Order Hub" template must not apply here.
  title: { absolute: "Eat For Less — local food delivery, for less" },
  alternates: { canonical: "/" },
};

export default async function Page() {
  const base = await getEflBase();
  return <LandingPage base={base} />;
}
