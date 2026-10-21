// "This customer was at checkout when we asked them to sign in."
//
// Signing in can leave the page — Google's round trip, or the confirmation
// link in a sign-up email — and everything in React state goes with it. The
// basket itself is safe in localStorage (lib/cart-storage), but it is keyed by
// shop AND brand, so coming back on a URL without ?brand= shows an empty
// basket that isn't really empty. This note remembers which brand they were
// on and that they were mid-checkout, so the storefront can put them back on
// the same basket with it open, instead of on the menu wondering where their
// food went.
//
// An hour is plenty for a sign-in and short enough that tomorrow's visit
// isn't hijacked by today's abandoned checkout.

const KEY = "orderhub.checkoutResume";
const TTL_MS = 60 * 60 * 1000;

type CheckoutResume = { slug: string; brandId: string | null; at: number };

export const rememberCheckout = (slug: string, brandId: string | null) => {
  try {
    const note: CheckoutResume = { slug, brandId, at: Date.now() };
    window.localStorage.setItem(KEY, JSON.stringify(note));
  } catch {
    /* private mode / full storage — sign-in still works, just no resume */
  }
};

/** The note for this shop, if there is a fresh one. */
export const readCheckout = (slug: string): CheckoutResume | null => {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const note = JSON.parse(raw) as CheckoutResume;
    if (note?.slug !== slug || Date.now() - note.at > TTL_MS) return null;
    return note;
  } catch {
    return null;
  }
};

export const forgetCheckout = () => {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
};
