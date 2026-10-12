import type { Metadata } from "next";
import { Archivo } from "next/font/google";

// The guest side of a barber or salon: booking, manage-my-booking, the
// walk-in queue and the screen by the door. Archivo's width axis gives the
// condensed, sign-painted headings a barber's window has, from the same
// family as the body text.
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
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
