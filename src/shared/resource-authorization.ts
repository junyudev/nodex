import type { ProjectLifecycle, ProjectResourceAccess } from "./library";

export type LibraryResource =
  | { readonly kind: "page"; readonly pageId: string }
  | { readonly kind: "database"; readonly databaseId: string }
  | { readonly kind: "canvas"; readonly canvasId: string }
  | { readonly kind: "data_source"; readonly dataSourceId: string }
  | { readonly kind: "view"; readonly viewId: string };

export type ProjectResourceAction =
  | "read"
  | "write"
  | "create_child"
  | "move"
  | "manage_schema"
  | "manage_views"
  | "manage_database";

export type ProjectResourceAuthorizationSource =
  | "implicit_database_binding"
  | "explicit_page_grant"
  | "explicit_database_grant"
  | "explicit_canvas_grant"
  | "thread_resource_consent"
  | "thread_full_access";

export type ProjectResourceAuthorizationReason =
  | "allowed"
  | "project_not_found"
  | "resource_not_found"
  | "resource_hierarchy_corrupt"
  | "library_mismatch"
  | "authority_stale"
  | "grant_missing"
  | "project_read_only"
  | "turn_read_only"
  | "grant_read_only"
  | "structural_capability_required";

export interface ProjectResourceAuthorization {
  readonly allowed: boolean;
  readonly projectId: string;
  readonly projectLifecycle: ProjectLifecycle | null;
  readonly resource: LibraryResource;
  readonly action: ProjectResourceAction;
  readonly libraryId: string | null;
  readonly effectiveAccess: ProjectResourceAccess | null;
  readonly source: ProjectResourceAuthorizationSource | null;
  readonly grantId: string | null;
  readonly reason: ProjectResourceAuthorizationReason;
}

export interface PutProjectResourceGrantInput {
  readonly projectId: string;
  readonly root:
    | { readonly kind: "page"; readonly pageId: string }
    | { readonly kind: "database"; readonly databaseId: string }
    | { readonly kind: "canvas"; readonly canvasId: string };
  readonly access: ProjectResourceAccess;
}

export interface RevokeProjectResourceGrantInput {
  readonly projectId: string;
  readonly grantId: string;
}
