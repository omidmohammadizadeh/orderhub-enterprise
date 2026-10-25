"use client";

import { createContext, useCallback, useContext } from "react";
import { eflHref, type EflBase } from "@/lib/efl-site";

const EflBaseContext = createContext<EflBase>("/eatforless");

export function EflBaseProvider({ base, children }: { base: EflBase; children: React.ReactNode }) {
  return <EflBaseContext.Provider value={base}>{children}</EflBaseContext.Provider>;
}

/** Build an Eat For Less link that works on both hosts. */
export function useEflHref(): (path: string) => string {
  const base = useContext(EflBaseContext);
  return useCallback((path: string) => eflHref(base, path), [base]);
}
