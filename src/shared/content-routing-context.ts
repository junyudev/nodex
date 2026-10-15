const MAX_CONTENT_ROUTING_ID_LENGTH = 512;

export type ContentRoutingContext =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "library" };

export type ProjectContentRoutingContext = Extract<
  ContentRoutingContext,
  { readonly kind: "project" }
>;

export type LibraryContentRoutingContext = Extract<
  ContentRoutingContext,
  { readonly kind: "library" }
>;

/**
 * Library identifies the physical content lifetime. Routing context identifies
 * its Library surface or Project presentation, independently of content access.
 */
export interface ContentRoutingIdentity {
  readonly libraryId: string;
  readonly routingContext: ContentRoutingContext;
}

export interface ContentPageNavigationTarget {
  readonly routingContext: ContentRoutingContext;
  readonly pageId: string;
  readonly titleSnapshot?: string;
  /** Best-effort semantic focus target after the Page surface is ready. */
  readonly sourceBlockId?: string;
}

export interface ContentCanvasNavigationTarget {
  readonly routingContext: ContentRoutingContext;
  readonly canvasBlockId: string;
  readonly titleSnapshot?: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalId = (value: unknown, label: string): string => {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CONTENT_ROUTING_ID_LENGTH &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return value;
  }
  throw new TypeError(`${label} must be a canonical non-empty identity`);
};

const assertExactKeys = (
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
): void => {
  const expected = new Set(required);
  for (const key of required) {
    if (Object.hasOwn(value, key)) continue;
    throw new TypeError(`contentRoutingContext.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (expected.has(key)) continue;
    throw new TypeError(`contentRoutingContext.${key} is not supported`);
  }
};

export const parseContentRoutingContext = (value: unknown): ContentRoutingContext => {
  if (!isRecord(value)) {
    throw new TypeError("contentRoutingContext must be an object");
  }
  if (value.kind === "library") {
    assertExactKeys(value, ["kind"]);
    return { kind: "library" };
  }
  if (value.kind === "project") {
    assertExactKeys(value, ["kind", "projectId"]);
    return {
      kind: "project",
      projectId: canonicalId(value.projectId, "contentRoutingContext.projectId"),
    };
  }
  throw new TypeError("contentRoutingContext.kind is unsupported");
};

export const projectContentRoute = (projectId: string): ProjectContentRoutingContext => {
  const context = parseContentRoutingContext({ kind: "project", projectId });
  if (context.kind === "project") return context;
  throw new TypeError("Project content routing context is invalid");
};

export const libraryContentRoute: LibraryContentRoutingContext = {
  kind: "library",
};

/**
 * Resolve the Project presentation or default destination, when selected.
 * Library routing has no default Project; content operations remain available.
 */
export const projectIdFromContentRoutingContext = (
  context: ContentRoutingContext,
): string | null => (context.kind === "project" ? context.projectId : null);

export const contentRoutingContextKey = (context: ContentRoutingContext): string => {
  const parsed = parseContentRoutingContext(context);
  return parsed.kind === "project" ? `project:${parsed.projectId}` : "library";
};

export const contentRoutingIdentityKey = (identity: ContentRoutingIdentity): string =>
  JSON.stringify([
    canonicalId(identity.libraryId, "contentRoutingIdentity.libraryId"),
    contentRoutingContextKey(identity.routingContext),
  ]);
