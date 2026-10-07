// Google Calendar appointment schedule ("30 min with OMID") behind the
// marketing site's "Book a demo" buttons. Google owns availability,
// invites and the Meet link; we only embed it. Override via env to swap
// schedules without a code change.

/** Embeddable schedule page (`?gv=true` is Google's iframe mode). */
export const DEMO_BOOKING_EMBED_URL =
  process.env.NEXT_PUBLIC_DEMO_BOOKING_EMBED_URL ||
  "https://calendar.google.com/calendar/appointments/schedules/AcZssZ2IY834qr7kgVK1pkjbXfkAXDEToYJZS_zykTWo-se52c7psOaConTkLw0EbSA0qYuYm2qxZqdd?gv=true";

/** Short share link — opened in a new tab where an iframe is too cramped. */
export const DEMO_BOOKING_URL =
  process.env.NEXT_PUBLIC_DEMO_BOOKING_URL ||
  "https://calendar.app.google/ENGAn1EwRQitXngW8";
