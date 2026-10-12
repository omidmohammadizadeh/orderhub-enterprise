import type { Metadata } from "next";

// Walk-in loyalty card pages. Private to the customer holding the link, so
// never indexed.
export const metadata: Metadata = {
  title: "Loyalty card",
  robots: { index: false, follow: false },
};

export default function LoyaltyLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`@keyframes stamp-pop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.18);opacity:1}100%{transform:scale(1)}}`}</style>
      {children}
    </>
  );
}
