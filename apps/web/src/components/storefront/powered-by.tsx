// "Powered by Order Hub Solutions" — the credit at the foot of a storefront.
//
// One component rather than a line of markup repeated on each tab, because
// there are five places a customer can be standing (menu, home, orders,
// rewards, checkout) and a credit that appears on some of them reads like an
// accident. It also keeps the logo, the wording and the link in one place to
// change.
//
// Mobile carries a fixed tab bar pinned to the bottom of the viewport, so the
// credit needs clearance or the bar sits on top of it: `pb-24 md:pb-8` leaves
// room for the bar on a phone and removes it on a laptop, where no bar is
// rendered. Pass `noTabBar` on a page without the bar (checkout, confirmation)
// to drop the extra space.

import Image from "next/image";

export function PoweredByOrderHub({ noTabBar = false }: { noTabBar?: boolean }) {
  return (
    <footer
      className={`px-4 pt-8 text-center ${noTabBar ? "pb-8" : "pb-24 md:pb-8"}`}
    >
      <a
        href="https://www.orderhubsolutions.com"
        target="_blank"
        // noreferrer as well as noopener: this link sits on shops running
        // their own custom domains, and their URL is not ours to leak.
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-lg px-2 py-2 text-zinc-400 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2"
      >
        {/* The logo file is a black badge centred in a square of white
            padding, so at this size the mark itself only covers about 45% of
            the image and reads as a grey smudge. Crop to it: a fixed box that
            hides the overflow, with the image scaled up inside. Cheaper and
            more reversible than shipping a second cropped asset, and it still
            tracks whatever logo the operator drops at /orderhub-logo.png. */}
        <span className="relative block h-[22px] w-[22px] shrink-0 overflow-hidden rounded-[5px]">
          <Image
            src="/orderhub-logo.png"
            alt=""
            width={22}
            height={22}
            // Decorative: the words beside it already say who this is, so a
            // screen reader reading the logo too would just say it twice.
            aria-hidden="true"
            className="h-full w-full scale-[2.1] object-contain"
          />
        </span>
        <span className="text-[11px] font-medium tracking-wide">
          Powered by{" "}
          <span className="font-bold text-zinc-500">Order Hub Solutions</span>
        </span>
      </a>
    </footer>
  );
}
