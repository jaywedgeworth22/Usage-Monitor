import { describe, expect, it } from "vitest";
import { shouldShowDashboardSkeleton } from "@/hooks/useDashboardData";

describe("shouldShowDashboardSkeleton", () => {
  it("shows the skeleton only during the initial load with no rows yet", () => {
    expect(
      shouldShowDashboardSkeleton({ loading: true, providerCount: 0 })
    ).toBe(true);
  });

  it("keeps the dashboard painted when loading flips true after rows arrived", () => {
    // Regression: overlapping foreground refetch used to set loading=true and
    // blank the page after the first successful paint (flash → stuck skeleton).
    expect(
      shouldShowDashboardSkeleton({ loading: true, providerCount: 3 })
    ).toBe(false);
  });

  it("hides the skeleton once the initial fetch settles", () => {
    expect(
      shouldShowDashboardSkeleton({ loading: false, providerCount: 0 })
    ).toBe(false);
    expect(
      shouldShowDashboardSkeleton({ loading: false, providerCount: 2 })
    ).toBe(false);
  });
});
