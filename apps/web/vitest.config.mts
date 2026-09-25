// .mts, not .ts: this package is CommonJS, and Vite's native config loader
// refuses ESM syntax in a file it loads as CJS.
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Unit tests for the dashboard. Deliberately narrow: `include` only picks up
// files under src, so this never tries to run the API's jest specs or anything
// in node_modules, and `next build` output is left alone.
//
// jsdom rather than node, because the things worth testing here (a till
// choosing which card machine to charge) are React state as often as they are
// pure functions.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    restoreMocks: true,
  },
  resolve: {
    // Mirrors the "@/*" path alias in tsconfig — without it every import in a
    // component under test fails to resolve.
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
});
