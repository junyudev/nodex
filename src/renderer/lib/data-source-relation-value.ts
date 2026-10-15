export interface RelationTargetPreview {
  readonly kind: "visible";
  readonly edgeId: string;
  readonly pageId: string;
  readonly title: string;
  readonly lifecycle: string;
  readonly membershipState: string;
}

export type RelationTargetWindowItem =
  | RelationTargetPreview
  | { readonly kind: "unavailable"; readonly edgeId: string };

export interface RelationValuePreview {
  readonly valueRevision: number;
  readonly totalCount: number;
  readonly targets: readonly RelationTargetPreview[];
  readonly unavailableCount: number;
  readonly hasMore: boolean;
}

export interface RelationTargetWindow {
  readonly valueRevision: number;
  readonly totalCount: number;
  readonly targets: readonly RelationTargetWindowItem[];
  readonly nextCursor: string | null;
  readonly projectionRevision: number;
}

export interface RelationCandidateWindow {
  readonly candidates: readonly { readonly pageId: string; readonly title: string }[];
  readonly nextCursor: string | null;
  readonly projectionRevision: number;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const nonnegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const opaqueEdgeId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const readTarget = (input: unknown): RelationTargetPreview | null => {
  const target = record(input);
  if (!target) return null;
  if (
    target.kind !== "visible" ||
    !opaqueEdgeId(target.edge_id) ||
    typeof target.page_id !== "string" ||
    target.page_id.length === 0 ||
    typeof target.title !== "string" ||
    typeof target.lifecycle !== "string" ||
    typeof target.membership_state !== "string"
  )
    return null;
  return {
    kind: "visible",
    edgeId: target.edge_id,
    pageId: target.page_id,
    title: target.title,
    lifecycle: target.lifecycle,
    membershipState: target.membership_state,
  };
};

export const readRelationValuePreview = (input: unknown): RelationValuePreview | null => {
  const tagged = record(input);
  const value = tagged?.kind === "relation" ? record(tagged.value) : null;
  if (
    !value ||
    !Array.isArray(value.targets) ||
    !nonnegativeSafeInteger(value.value_revision) ||
    !nonnegativeSafeInteger(value.total_count) ||
    !nonnegativeSafeInteger(value.unavailable_count) ||
    typeof value.has_more !== "boolean"
  )
    return null;
  const targets = value.targets.map(readTarget);
  const visibleIds = new Set(
    targets.flatMap((target) => (target?.kind === "visible" ? [target.pageId] : [])),
  );
  if (
    targets.some((target) => target === null) ||
    targets.length > 3 ||
    visibleIds.size !== targets.length ||
    value.total_count < value.unavailable_count + targets.length ||
    value.has_more !== value.total_count > targets.length
  )
    return null;
  return {
    valueRevision: value.value_revision,
    totalCount: value.total_count,
    targets: targets as readonly RelationTargetPreview[],
    unavailableCount: value.unavailable_count,
    hasMore: value.has_more,
  };
};
