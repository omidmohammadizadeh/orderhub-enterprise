"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { LocateFixed, MapPin } from "lucide-react";
import { useEflHref } from "../efl-base-context";
import { FOCUS } from "../efl-styles";
import { normalisePostcode } from "../postcode";

/**
 * The hero's address box: a postcode and "Find food", or the browser's own
 * location. The feed page does the geocoding, so this only validates the
 * shape and moves on.
 */
export function PostcodeSearch({ initialPostcode = "" }: { initialPostcode?: string }) {
  const router = useRouter();
  const href = useEflHref();
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState(initialPostcode);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const postcode = normalisePostcode(value);
    if (!postcode) {
      setError(value.trim() ? "That doesn't look like a UK postcode. Try something like NE1 4ST." : "Enter your postcode to see shops near you.");
      return;
    }
    setError(null);
    router.push(href(`/near?postcode=${encodeURIComponent(postcode)}`));
  }

  function locateMe() {
    if (!("geolocation" in navigator)) {
      setError("Your browser can't share your location. Enter your postcode instead.");
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude.toFixed(5);
        const lng = pos.coords.longitude.toFixed(5);
        router.push(href(`/near?lat=${lat}&lng=${lng}`));
      },
      () => {
        setLocating(false);
        setError("We couldn't get your location. Enter your postcode instead.");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex w-full max-w-[560px] flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor={inputId} className="sr-only">
          Your postcode
        </label>
        <div className="relative flex-1">
          <MapPin aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#0B0B0B]" />
          <input
            id={inputId}
            name="postcode"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Enter your postcode"
            autoComplete="postal-code"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="search"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="h-14 w-full rounded-xl border-2 border-transparent bg-white pl-12 pr-4 text-[17px] font-medium text-[#0B0B0B] shadow-[0_1px_2px_rgba(0,0,0,.06)] placeholder:text-[#5E5E5E] focus:border-[#0B0B0B] focus:outline-none"
          />
        </div>
        <button
          type="submit"
          className={`efl-press h-14 shrink-0 rounded-xl bg-[#0B0B0B] px-7 text-[17px] font-bold text-white hover:bg-[#262626] ${FOCUS}`}
        >
          Find food
        </button>
      </div>
      <p id={errorId} aria-live="polite" className="m-0 text-[15px] font-semibold text-[#0B0B0B]">
        {error ?? ""}
      </p>
      <button
        type="button"
        onClick={locateMe}
        disabled={locating}
        className={`efl-press inline-flex min-h-[44px] w-fit items-center gap-2 rounded-full px-1 text-[15px] font-bold text-[#0B0B0B] underline-offset-4 hover:underline disabled:opacity-60 ${FOCUS}`}
      >
        <LocateFixed aria-hidden="true" className="h-[18px] w-[18px]" />
        {locating ? "Finding you…" : "Use my current location"}
      </button>
    </form>
  );
}
