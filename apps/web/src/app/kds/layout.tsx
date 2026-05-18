import type { Metadata } from "next";

export const metadata: Metadata = { title: "Kitchen Display — OrderHub" };

export default function KdsLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-black text-white antialiased">
        {children}
      </body>
    </html>
  );
}
