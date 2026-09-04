export const AGENT_WINDOW_IDS = ["5h", "24h", "7d", "30d", "all"] as const;
export type AgentWindowId = (typeof AGENT_WINDOW_IDS)[number];

export interface AgentWindowChip {
  id: AgentWindowId;
  /** Compact label.  Hours and days use 5h / 7d / 30d.  All Time stays one word-pair. */
  label: string;
}

export const AGENT_WINDOW_CHIPS: readonly AgentWindowChip[] = [
  { id: "5h", label: "5h" },
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "all", label: "All Time" },
];
