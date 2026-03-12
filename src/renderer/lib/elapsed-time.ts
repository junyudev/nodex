export function formatElapsedSince(updatedAtMs: number, nowMs: number): string {
  const elapsedSeconds = Math.max(Math.floor((nowMs - updatedAtMs) / 1_000), 0);

  if (elapsedSeconds < 60) return "now";

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d`;
  if (elapsedDays < 30) return `${Math.floor(elapsedDays / 7)}w`;
  if (elapsedDays < 365) return `${Math.floor(elapsedDays / 30)}mo`;
  return `${Math.floor(elapsedDays / 365)}y`;
}
