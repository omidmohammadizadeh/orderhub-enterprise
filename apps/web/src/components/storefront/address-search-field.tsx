"use client";

// One search box that fills in a delivery address, for customers.
//
// The POS has had this for a while; this is the same thing for the people
// actually placing the orders. A customer typing "12 Front Street" and picking
// their house is the difference between a clean delivery and a driver ringing
// to ask which flat.
//
// Self-contained on purpose: it owns its query, its suggestions and its
// loading state, and hands back a finished address through onPick. The two
// storefront panels that use it (the ordinary cart and the group basket)
// already thread a dozen address props through the page, and this would have
// been six more in two places.

import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { Loader2, Search } from "lucide-react";

// Same base the rest of the storefront uses — "/api" goes through the Next
// rewrite, which is what makes brand custom domains work.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

/** What the caller gets back. Every field optional: a provider that can only
 *  resolve town + postcode must not be allowed to blank out a street the
 *  customer already typed. */
export interface PickedAddress {
  line1?: string;
  line2?: string;
  city?: string;
  postcode?: string;
}

interface Suggestion {
  id: string;
  label: string;
  line1?: string;
  line2?: string;
  city?: string;
  postcode?: string;
  provider: string;
}

/** Below this we don't call out at all. Every keystroke past it is a billable
 *  Google autocomplete request, and "12" matches most of the country. */
const MIN_CHARS = 4;

/** Long enough that typing an address is one or two requests rather than one
 *  per letter. The customer never notices; the bill does. */
const DEBOUNCE_MS = 400;

export function AddressSearchField({
  onPick,
  country = "gb",
}: {
  onPick: (address: PickedAddress) => void;
  country?: string;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [resolving, setResolving] = useState(false);
  // null = still asking. Until we know, render nothing rather than a search
  // box that might be about to disappear.
  const [provider, setProvider] = useState<string | null>(null);

  // Set when the customer picks something, so the effect that watches `query`
  // doesn't immediately re-search the text we just put in the box.
  const suppress = useRef(false);

  useEffect(() => {
    let cancelled = false;
    axios
      .get<{ searchProvider: string }>(`${API_BASE}/v1/address-lookup/status`)
      .then((r) => {
        if (!cancelled) setProvider(r.data.searchProvider);
      })
      // A failed status check means no search box. Manual entry still works,
      // which is the whole reason those fields stay on screen.
      .catch(() => {
        if (!cancelled) setProvider("manual");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (suppress.current) {
      suppress.current = false;
      return;
    }
    if (!provider || provider === "manual") return;
    if (query.trim().length < MIN_CHARS) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = await axios.get<{ suggestions: Suggestion[] }>(
          `${API_BASE}/v1/address-lookup/search`,
          { params: { q: query, country, limit: 5 } },
        );
        if (!cancelled) setSuggestions(res.data.suggestions ?? []);
      } catch {
        // Silent. A customer mid-address doesn't want an error banner — the
        // manual fields below are right there and still work.
        if (!cancelled) setSuggestions([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query, provider, country]);

  /**
   * Google's autocomplete returns predictions, not addresses — line1 is the
   * display text and city/postcode are blank until the place id is resolved.
   * Every other provider returns a structured suggestion in one hop, so this
   * short-circuits for them rather than spending a details call.
   */
  const pick = async (s: Suggestion) => {
    suppress.current = true;
    setQuery(s.label);
    setSuggestions([]);

    if (s.provider !== "google") {
      onPick(s);
      return;
    }
    // Fill what we have first so the fields aren't empty while we resolve.
    onPick(s);
    setResolving(true);
    try {
      const res = await axios.get<{ suggestion: Suggestion | null }>(
        `${API_BASE}/v1/address-lookup/details`,
        { params: { id: s.id } },
      );
      if (res.data.suggestion) onPick(res.data.suggestion);
    } catch {
      // Leave the optimistic fill. The customer can finish the postcode by
      // hand, which beats wiping what they picked.
    } finally {
      setResolving(false);
    }
  };

  if (!provider || provider === "manual") return null;

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your address"
          autoComplete="off"
          className="w-full rounded-md border border-zinc-200 py-1.5 pl-7 pr-7 text-xs focus:border-zinc-900 focus:outline-none"
        />
        {(searching || resolving) && (
          <Loader2 className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-zinc-400" />
        )}
      </div>

      {suggestions.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-52 w-full overflow-y-auto rounded-md border border-zinc-200 bg-white shadow-lg">
          {suggestions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                // onMouseDown, not onClick: a click fires after blur, and on
                // mobile the keyboard dismissing can move the list out from
                // under the finger before the tap lands.
                onMouseDown={(e) => {
                  e.preventDefault();
                  void pick(s);
                }}
                className="w-full px-2.5 py-2 text-left text-[11px] leading-snug hover:bg-zinc-50"
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-1 text-[11px] text-zinc-400">
        Can&apos;t find it? Type your address below.
      </p>
    </div>
  );
}
