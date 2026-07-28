import type { Metadata } from "next";

// Table QR pages are behind an unguessable, rotatable token — keep them out
// of search indexes. Server layout that only sets metadata and passes
// children through, so the page still inherits the root layout's fonts +
// QueryProvider (no nested <html>/<body>).
export const metadata: Metadata = {
  title: "Order at your table",
  robots: { index: false, follow: false },
};

export default function TableQrLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
