import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { QueryProvider } from "@/providers/query-provider";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Order Hub Solutions",
    template: "%s · Order Hub",
  },
  description:
    "Omnichannel restaurant integration platform. Unify Uber Eats, Deliveroo, Just Eat, and direct orders in one place.",
  robots: { index: false, follow: false }, // Private SaaS — never index
};

export const viewport: Viewport = {
  themeColor: "#0a0a0b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen bg-zinc-50 font-sans">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
