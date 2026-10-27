import Link from "next/link";
import { FOCUS } from "@/components/eatforless/efl-styles";
import { FoodTile } from "@/components/eatforless/food-art";
import { SiteHeader } from "@/components/eatforless/site-header";
import { eflHref } from "@/lib/efl-site";
import { getEflBase } from "@/lib/efl-site.server";

export default async function NotFound() {
  const base = await getEflBase();
  return (
    <>
      <SiteHeader base={base} />
      <main className="mx-auto flex max-w-[640px] flex-col items-center gap-5 px-4 py-24 text-center">
        <div className="h-28 w-28 overflow-hidden rounded-full">
          <FoodTile kind="burger" />
        </div>
        <h1 className="m-0 text-[36px] font-extrabold leading-tight tracking-[-0.03em]">We can&rsquo;t find that page</h1>
        <p className="m-0 text-base text-[#5E5E5E]">It may have moved. Let&rsquo;s get you back to the food.</p>
        <Link
          href={eflHref(base, "/")}
          className={`efl-press inline-flex min-h-[48px] items-center rounded-full bg-[#0B0B0B] px-6 text-[15px] font-bold text-white ${FOCUS}`}
        >
          Go to Eat For Less
        </Link>
      </main>
    </>
  );
}
