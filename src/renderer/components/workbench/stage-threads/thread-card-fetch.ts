import type { Card } from "@/lib/types";

function isCardResult(value: unknown): value is Card {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<Card>;
  return (
    typeof candidate.id === "string"
    && typeof candidate.status === "string"
    && typeof candidate.title === "string"
  );
}

export function resolveThreadCardResult(value: unknown): Card | null {
  if (!isCardResult(value)) return null;
  return value;
}

export function resolveThreadCardStatus(value: unknown): Card["status"] | null {
  return resolveThreadCardResult(value)?.status ?? null;
}
