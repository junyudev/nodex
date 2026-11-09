import type { DataSourcePagePropertyMenuDescriptor } from "@/components/database/data-source-page-property-menu-source";
import { resolveDataSourcePropertyPresentationRole } from "@/lib/data-source-property-presentation-role";

const DEFAULT_FEATURED_LIMIT = 7;

const FEATURED_ROLE_RANK: Readonly<Partial<Record<string, number>>> = {
  status: 0,
  priority: 1,
  due_date: 3,
  tags: 4,
  estimate: 5,
};

export interface PagePropertyContextMenuModel {
  /** Root entries. With a query, this is the complete matching Property set. */
  readonly visible: readonly DataSourcePagePropertyMenuDescriptor[];
  /** Non-featured Properties shown below `More properties…` when not searching. */
  readonly overflow: readonly DataSourcePagePropertyMenuDescriptor[];
  readonly searching: boolean;
  readonly hasMatches: boolean;
}

const normalizedSearchText = (value: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase();

const featuredRank = (
  binding: DataSourcePagePropertyMenuDescriptor,
  groupingPropertyId: string | null,
): number | null => {
  if (String(binding.property.propertyId) === groupingPropertyId) return -1;
  const role = resolveDataSourcePropertyPresentationRole(binding.property);
  return FEATURED_ROLE_RANK[role.kind] ?? null;
};

/**
 * Produces the compact schema-driven menu without guessing semantics from labels.
 * Input order remains the tie-breaker so custom schema rank is preserved.
 */
export const buildPagePropertyContextMenuModel = (
  bindings: readonly DataSourcePagePropertyMenuDescriptor[],
  {
    groupingPropertyId = null,
    query = "",
    featuredLimit = DEFAULT_FEATURED_LIMIT,
  }: {
    readonly groupingPropertyId?: string | null;
    readonly query?: string;
    readonly featuredLimit?: number;
  } = {},
): PagePropertyContextMenuModel => {
  const active = bindings.filter(
    (binding) =>
      binding.property.lifecycle === "active" && binding.property.valueType !== "assignment",
  );
  const normalizedQuery = normalizedSearchText(query);
  if (normalizedQuery) {
    const matches = active.filter((binding) =>
      normalizedSearchText(binding.property.name).includes(normalizedQuery),
    );
    return {
      visible: matches,
      overflow: [],
      searching: true,
      hasMatches: matches.length > 0,
    };
  }

  const featured = active
    .map((binding, index) => ({
      binding,
      index,
      rank: featuredRank(binding, groupingPropertyId),
    }))
    .filter((entry): entry is typeof entry & { readonly rank: number } => entry.rank !== null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, Math.max(0, featuredLimit))
    .map((entry) => entry.binding);
  const featuredIds = new Set(featured.map((binding) => binding.property.propertyId));
  const overflow = active.filter((binding) => !featuredIds.has(binding.property.propertyId));

  return {
    visible: featured,
    overflow,
    searching: false,
    hasMatches: featured.length > 0 || overflow.length > 0,
  };
};
