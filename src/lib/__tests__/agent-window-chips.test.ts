import { describe, expect, it } from "vitest";
import { AGENT_WINDOW_CHIPS } from "../agent-window-chips";

describe("AGENT_WINDOW_CHIPS", () => {
  it("uses compact hour/day labels and keeps All Time as one unwrapped phrase", () => {
    expect(AGENT_WINDOW_CHIPS.map((chip) => chip.label)).toEqual([
      "5h",
      "24h",
      "7d",
      "30d",
      "All Time",
    ]);
    for (const chip of AGENT_WINDOW_CHIPS) {
      expect(chip.label.includes("\n")).toBe(false);
    }
    expect(AGENT_WINDOW_CHIPS.find((chip) => chip.id === "all")?.label).toBe("All Time");
  });
});
