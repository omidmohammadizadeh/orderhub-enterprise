// Keeps account-backed state in step with the session: on sign-in, load the
// account's addresses and favourites and register for order updates; on
// sign-out, fall back to the device's lists.

import { useSession } from "@/auth/session";
import { registerForOrderUpdates, unregisterOrderUpdates } from "@/lib/push";
import { useAddresses } from "./address";
import { useFavourites } from "./favourites";

function onSignedIn(asked: boolean) {
  void useAddresses.getState().loadRemote().catch(() => {});
  void useFavourites.getState().loadRemote().catch(() => {});
  void registerForOrderUpdates({ ask: asked, marketingOptIn: useSession.getState().marketingOptIn });
}

/** Call once at start-up, after the session has hydrated. */
export function startAccountSync(): () => void {
  if (useSession.getState().token) onSignedIn(false);
  return useSession.subscribe((s, prev) => {
    if (s.token && !prev.token) onSignedIn(true);
    if (!s.token && prev.token) {
      useAddresses.getState().dropRemote();
      useFavourites.getState().dropRemote();
    }
  });
}

/** Sign out, removing this phone from the account's notifications first
 *  (that call needs the token, so it can't wait for the session to clear). */
export async function signOut(): Promise<void> {
  await unregisterOrderUpdates();
  await useSession.getState().signOut();
}
