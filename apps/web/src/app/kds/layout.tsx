import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Kitchen Display — OrderHub",
  robots: { index: false, follow: false },
};

export default function KdsLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-black text-white antialiased">
        {children}
      </body>
    </html>
  );
}
