// jest-dom's matchers (toBeInTheDocument, toHaveTextContent…) for Vitest.
import { beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// localStorage exists in jsdom, but Zustand's persist middleware keeps state
// between test files in the same worker. Each test file that touches a
// persisted store resets it explicitly; this clears the backing store so a
// leftover value can't make a test pass for the wrong reason.
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // jsdom without storage — nothing to clear.
  }
});
