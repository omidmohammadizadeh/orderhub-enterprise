import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SolutionDetail } from "@/components/marketing/detail/solution-detail";
import {
  SOLUTION_META,
  SOLUTION_META_BY_SLUG,
} from "@/components/marketing/detail/catalog";

export function generateStaticParams() {
  return SOLUTION_META.map((s) => ({ slug: s.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const s = SOLUTION_META_BY_SLUG[slug];
  if (!s) return { title: "Order Hub" };
  return {
    title: `${s.name} — Order Hub`,
    description: s.description,
  };
}

export default async function SolutionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!SOLUTION_META_BY_SLUG[slug]) notFound();
  return <SolutionDetail slug={slug} />;
}
