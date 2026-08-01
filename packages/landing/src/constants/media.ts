export const landingMediaStatus: "pending" | "ready" = "pending";

export const landingMediaNames = [
  "hero-video",
  "workspaces",
  "compact-mode",
  "glance",
  "split-views",
] as const;

export const landingMediaBudget = {
  posterBytes: 300_000,
  videoBytes: 4_000_000,
} as const;
