// Over-the-air updates (expo-updates).
//
// Why this exists: a JS-only fix used to need a native rebuild and a store
// round-trip before a driver could get it. With `updates.url` + a channel per
// build profile in eas.json, `eas update --branch <branch>` reaches every
// install whose runtimeVersion matches (policy `appVersion`, so every build of
// app.json's `version`).
//
// expo-updates already checks at cold launch (`checkAutomatically: ON_LOAD`)
// and applies what it downloads on the NEXT launch. That is not enough on its
// own: a driver leaves this app open across a whole shift, so a fix published
// at 6pm would sit undownloaded until they force-quit. The App-level wiring
// therefore re-checks on every foreground and reloads at a safe moment.
//
// A reload is never worth interrupting a delivery for — App.tsx owns that
// decision (no active stop, nothing open, nothing in flight); this module just
// does the network work.

import * as Updates from "expo-updates";

/** Drivers bounce between this app and their sat-nav constantly; don't hit the
 *  update server on every single foreground. */
const CHECK_INTERVAL_MS = 5 * 60_000;
let lastCheckedAt = 0;
let staged = false;

/**
 * Check for a newer bundle and download it. Resolves true when one is staged
 * and ready for {@link applyDownloadedUpdate}.
 *
 * Safe to call repeatedly and while offline: no update, no network, or no
 * bundle matching this runtime version all resolve false rather than throwing.
 * Always false in Expo Go and dev builds, where updates are disabled.
 *
 * Note `checkForUpdateAsync` compares against the *running* bundle, so once
 * something is staged it keeps reporting "available" — hence the `staged`
 * short-circuit, or every foreground would re-download the same bundle.
 */
export async function downloadUpdateIfAvailable(): Promise<boolean> {
  if (__DEV__ || !Updates.isEnabled) return false;
  if (staged) return true;
  const now = Date.now();
  if (now - lastCheckedAt < CHECK_INTERVAL_MS) return false;
  lastCheckedAt = now;
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return false;
    const fetched = await Updates.fetchUpdateAsync();
    staged = fetched.isNew;
    return staged;
  } catch {
    // Offline, or the update server is unreachable. Try again next foreground.
    return false;
  }
}

/**
 * Restart into the downloaded bundle. Only ever called at a safe moment.
 *
 * Attempted once per app session: if the reload fails we leave the update
 * staged rather than retrying in a loop — the next cold launch picks it up,
 * which is expo-updates' own default behaviour anyway.
 */
let reloadAttempted = false;
export async function applyDownloadedUpdate(): Promise<void> {
  if (reloadAttempted) return;
  reloadAttempted = true;
  try {
    await Updates.reloadAsync();
  } catch {
    // Staged; the next launch runs it.
  }
}

/** For the profile screen / support calls: which bundle is this driver on. */
export function updateInfo(): { channel: string | null; runtimeVersion: string | null; updateId: string | null } {
  return {
    channel: Updates.channel,
    runtimeVersion: Updates.runtimeVersion,
    updateId: Updates.updateId,
  };
}
