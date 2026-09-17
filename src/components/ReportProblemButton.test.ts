import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("subtle Sentry support trigger", () => {
  it("wires Report a Problem on the support page and error boundary", () => {
    const button = readFileSync(
      join(import.meta.dirname, "ReportProblemButton.tsx"),
      "utf8"
    );
    const support = readFileSync(
      join(import.meta.dirname, "../app/support/page.tsx"),
      "utf8"
    );
    const errorPage = readFileSync(
      join(import.meta.dirname, "../app/error.tsx"),
      "utf8"
    );
    expect(button).toMatch(/openSentryFeedback/);
    expect(button).toMatch(/mailto:mail@jays\.services/);
    expect(support).toMatch(/ReportProblemButton/);
    expect(support).toMatch(/Report a Problem with this dashboard/);
    expect(errorPage).toMatch(/ReportProblemButton/);
    expect(errorPage).toMatch(/Report a Problem/);
  });
});
