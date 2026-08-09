import { describe, expect, test } from "vitest";

// Smoke test for the test harness itself (T8) -- keeps `npm test` green
// before T3+ add real component coverage.
describe("test harness", () => {
  test("vitest + jsdom are wired up", () => {
    expect(typeof window).toBe("object");
  });
});
