import type { LibraryRouteTarget } from "./library-module";

export type ResourceLocationSegment =
  | {
      readonly kind: "page";
      readonly pageId: string;
      readonly title: string;
      readonly lifecycle: "active" | "archived";
    }
  | {
      readonly kind: "database";
      readonly databaseId: string;
      readonly title: string;
      readonly defaultViewId: string;
      readonly primaryProjectId: string | null;
    };

export type ResourceLocationReadModel = {
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly target: LibraryRouteTarget;
} & (
  | { readonly status: "missing" }
  | { readonly status: "available"; readonly segments: readonly ResourceLocationSegment[] }
);

export function resourceLocationTargetKey(target: LibraryRouteTarget): string {
  switch (target.kind) {
    case "page":
      return `page:${target.pageId}`;
    case "database":
      return `database:${target.databaseId}`;
    case "canvas":
      return `canvas:${target.canvasId}`;
    case "view":
      return `view:${target.viewId}`;
  }
}
