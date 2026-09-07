export interface NodexAgentAuthorizationFootprint {
  readonly tool:
    | "create"
    | "edit_document"
    | "transfer_blocks"
    | "edit_database"
    | "create_pages"
    | "update_page"
    | "advanced_update_page"
    | "move_pages"
    | "duplicate_page";
  readonly projectId: string | null;
  readonly effect: "write" | "destructive";
  readonly resources: readonly string[];
  readonly deletions: readonly string[];
  readonly transformations: readonly string[];
}

function canonical(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function authorizationFootprint(
  input: NodexAgentAuthorizationFootprint,
): NodexAgentAuthorizationFootprint {
  return {
    ...input,
    resources: canonical(input.resources),
    deletions: canonical(input.deletions),
    transformations: canonical(input.transformations),
  };
}

export function sameAuthorizationFootprint(
  left: NodexAgentAuthorizationFootprint,
  right: NodexAgentAuthorizationFootprint,
): boolean {
  return (
    JSON.stringify(authorizationFootprint(left)) === JSON.stringify(authorizationFootprint(right))
  );
}
