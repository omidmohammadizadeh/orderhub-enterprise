import type { Metadata } from "next";

// Signage boards are behind an unguessable token — keep them out of search
// indexes. This server layout only sets metadata + passes children through, so
// the page still inherits the root layout's fonts + QueryProvider (no nested
// <html>/<body>, avoiding the provider-drop pitfall).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function SignageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
