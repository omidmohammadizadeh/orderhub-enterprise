import type { Metadata } from "next";
import { Suspense } from "react";
import { FeedPage } from "@/components/eatforless/feed/feed-page";

export const metadata: Metadata = {
  title: "Food near you",
  description: "Takeaways near you on Eat For Less: same menus, lower prices.",
  alternates: { canonical: "/near" },
  robots: { index: false, follow: true },
};

export default function Page() {
  return (
    <Suspense fallback={null}>
      <FeedPage />
    </Suspense>
  );
}
