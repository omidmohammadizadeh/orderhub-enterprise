"use client";

// Route shell only — a named export from a page.tsx is an App Router build
// error, so the screen lives in a component.

import { ConsoleOverview } from "@/components/efl-console/console-overview";

export default function EflConsoleOverviewPage() {
  return <ConsoleOverview />;
}
