import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Sentry max-features client", () => {
  it("ships Feedback with a kill switch and keeps Replay on", () => {
    const src = readFileSync(
      join(import.meta.dirname, "instrumentation-client.ts"),
      "utf8"
    );
    expect(src).toMatch(/feedbackIntegration\(/);
    expect(src).toMatch(/NEXT_PUBLIC_SENTRY_FEEDBACK_ENABLED/);
    expect(src).toMatch(/replaysSessionSampleRate/);
  });
});
