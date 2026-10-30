import type { Metadata } from "next";
import localFont from "next/font/local";

// The guest side of a barber or salon: booking, manage-my-booking, the
// walk-in queue and the screen by the door. Archivo's width axis gives the
// condensed, sign-painted headings a barber's window has, from the same
// family as the body text.
const archivo = localFont({
  src: "../../fonts/archivo-latin-var.woff2",
  weight: "100 900",
  declarations: [{ prop: "font-stretch", value: "62% 125%" }],
  variable: "--font-salon",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Book an appointment",
  robots: { index: true, follow: true },
};

export default function SalonPublicLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${archivo.variable} salon-public min-h-screen`}>{children}</div>;
}
