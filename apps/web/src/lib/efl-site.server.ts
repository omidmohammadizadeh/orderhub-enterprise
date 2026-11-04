import "server-only";
import { headers } from "next/headers";
import { eflBaseFor, type EflBase } from "./efl-site";

/** The Eat For Less link base for this request (see lib/efl-site). */
export async function getEflBase(): Promise<EflBase> {
  const h = await headers();
  return eflBaseFor(h.get("x-site-brand"));
}
