// The site's motion and a couple of shared surfaces. Motion is opt-in: with
// reduced motion asked for, nothing moves and everything is simply there.

const CSS = `
.efl-root { --efl-ink:#0B0B0B; --efl-lime:#D4FF3F; --efl-soft:#F3F3F3; --efl-muted:#5E5E5E; --efl-line:#E2E2E2; }
.efl-root ::selection { background:#D4FF3F; color:#0B0B0B; }
.efl-scroll { scrollbar-width:none; -webkit-overflow-scrolling:touch; }
.efl-scroll::-webkit-scrollbar { display:none; }
.efl-skel { background:linear-gradient(90deg,#EEEEEE 0%,#F6F6F6 50%,#EEEEEE 100%); background-size:200% 100%; }
@media (prefers-reduced-motion: no-preference) {
  .efl-fu { animation: efl-fu .55s cubic-bezier(.2,.8,.2,1) both; }
  .efl-press { transition: transform .15s ease, background-color .15s ease, border-color .15s ease, color .15s ease; }
  .efl-press:active:not(:disabled) { transform: scale(.97); }
  .efl-lift { transition: transform .2s ease; }
  .efl-lift:hover .efl-zoom { transform: scale(1.03); }
  .efl-zoom { transition: transform .35s cubic-bezier(.2,.8,.2,1); }
  .efl-skel { animation: efl-shimmer 1.4s linear infinite; }
  .efl-pop { animation: efl-pop .18s cubic-bezier(.2,.8,.2,1) both; }
}
@keyframes efl-fu { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:none; } }
@keyframes efl-shimmer { from { background-position:200% 0; } to { background-position:-200% 0; } }
@keyframes efl-pop { from { opacity:0; transform:translateY(-4px) scale(.98); } to { opacity:1; transform:none; } }
`;

export function EflStyles() {
  return <style>{CSS}</style>;
}

/** Shared focus ring: black ring on light surfaces. */
export const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0B0B0B]";

/** Focus ring for dark surfaces. */
export const FOCUS_ON_DARK =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D4FF3F]";
