// Black header of the public "Partner with Eat For Less" page. Static, so it
// stays a server component; only the form below it ships JavaScript.

const STATS = [
  { value: "Low", label: "commission" },
  { value: "Weekly", label: "payouts" },
  { value: "Your", label: "drivers or ours" },
] as const;

/**
 * The page's motion, all opt-in: nothing moves for people who ask the OS
 * for reduced motion, and the tick is simply drawn.
 */
const MOTION_CSS = `
@media (prefers-reduced-motion: no-preference) {
  .efl-fu { animation: efl-fu .6s cubic-bezier(.2,.8,.2,1) both; }
  .efl-step { animation: efl-step .45s cubic-bezier(.2,1,.3,1) both; }
  .efl-bar { transition: width .5s cubic-bezier(.3,1.2,.5,1); }
  .efl-press { transition: transform .15s ease, background-color .15s ease; }
  .efl-press:active:not(:disabled) { transform: scale(.97); }
  .efl-ok { animation: efl-ok .6s cubic-bezier(.3,1.6,.5,1) both; }
  .efl-tick { stroke-dasharray: 30; stroke-dashoffset: 30; animation: efl-tick .5s .3s ease forwards; }
  .efl-spin { animation: efl-spin .8s linear infinite; }
}
@keyframes efl-fu { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes efl-step { from { opacity: 0; transform: translateX(18px); } to { opacity: 1; transform: none; } }
@keyframes efl-ok { from { transform: scale(.3); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes efl-tick { to { stroke-dashoffset: 0; } }
@keyframes efl-spin { to { transform: rotate(360deg); } }
`;

export function PartnerStyles() {
  return <style>{MOTION_CSS}</style>;
}

export function EflWordmark() {
  return (
    <span className="flex items-center gap-2.5 text-xl font-extrabold tracking-tight text-white">
      <span
        aria-hidden="true"
        className="flex h-[34px] w-[34px] items-center justify-center bg-[#D4FF3F] text-[#0B0B0B]"
        style={{ borderRadius: "10px 50% 50% 50%" }}
      >
        £
      </span>
      eat for less
    </span>
  );
}

export function PartnerHero() {
  return (
    <header className="bg-[#0B0B0B] px-4 pb-14 pt-5 text-white sm:px-6 sm:pt-[22px]">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-8 sm:gap-10">
        <div className="flex items-center justify-between gap-3">
          <EflWordmark />
          <a
            href="#apply"
            className="inline-flex min-h-[44px] items-center rounded-lg px-1 text-sm font-bold text-[#D4FF3F] underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D4FF3F]"
          >
            Apply now
          </a>
        </div>
        <div className="efl-fu flex flex-wrap items-end justify-between gap-8">
          <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-3.5">
            <h1
              className="m-0 font-extrabold leading-none tracking-[-0.04em] [text-wrap:balance]"
              style={{ fontSize: "clamp(36px, 6vw, 60px)" }}
            >
              Keep more of every order.
            </h1>
            <p className="m-0 max-w-[520px] text-[17px] leading-normal text-[#C9C9C9]">
              List your shop on Eat For Less alongside the apps you already use. No switching, no new till.
            </p>
          </div>
          <ul className="m-0 grid min-w-0 flex-[1_1_320px] list-none grid-cols-3 gap-2.5 p-0">
            {STATS.map((s) => (
              <li key={s.label} className="flex min-w-0 flex-col gap-1 rounded-2xl bg-[#1A1A1A] p-3 sm:p-3.5">
                <span className="text-[22px] font-extrabold leading-tight text-[#D4FF3F] sm:text-[26px]">{s.value}</span>
                <span className="text-xs leading-snug text-[#BDBDBD]">{s.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </header>
  );
}
