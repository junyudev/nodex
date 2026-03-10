import type { OccurrenceEditScope } from "@/lib/types";

export interface OccurrenceScopeOption {
  scope: OccurrenceEditScope;
  label: string;
  isPrimary?: boolean;
}

export function resolveOccurrenceScopeOptions(
  thisAndFutureEquivalentToAll: boolean,
): OccurrenceScopeOption[] {
  if (thisAndFutureEquivalentToAll) {
    return [
      { scope: "this", label: "Only this occurrence" },
      { scope: "all", label: "All occurrences", isPrimary: true },
    ];
  }

  return [
    { scope: "this", label: "Only this occurrence" },
    { scope: "this-and-future", label: "This and future", isPrimary: true },
  ];
}
