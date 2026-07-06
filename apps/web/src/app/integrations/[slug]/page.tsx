import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { IntegrationDetail } from "@/components/marketing/detail/integration-detail";
import {
  INTEGRATION_META,
  INTEGRATION_META_BY_SLUG,
} from "@/components/marketing/detail/catalog";

export function generateStaticParams() {
  return INTEGRATION_META.map((i) => ({ slug: i.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const i = INTEGRATION_META_BY_SLUG[slug];
  if (!i) return { title: "Order Hub" };
  return {
    title: `${i.name} integration — Order Hub`,
    description: i.description,
  };
}

export default async function IntegrationPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!INTEGRATION_META_BY_SLUG[slug]) notFound();
  return <IntegrationDetail slug={slug} />;
}
