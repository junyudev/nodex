import type {
  LibraryNavigationNode,
  LibraryPlacedResourceTarget,
  LibraryRouteTarget,
} from "../../shared/library-module";

export function resolveLibraryPathRoot(
  target: LibraryRouteTarget,
  nodes: readonly LibraryNavigationNode[],
): LibraryPlacedResourceTarget | null {
  const root = nodes[0];
  if (!root) return null;
  if (root.kind === "page") {
    return { kind: "page", pageId: root.pageId };
  }
  if (root.kind === "database") {
    return { kind: "database", databaseId: root.databaseId };
  }
  if (root.kind === "canvas") {
    return { kind: "canvas", canvasId: root.canvasId };
  }
  if (target.kind !== "view") return null;
  return { kind: "database", databaseId: root.databaseId };
}

export function areLibraryResourceTargetsEqual(
  left: LibraryPlacedResourceTarget,
  right: LibraryPlacedResourceTarget,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "page" && right.kind === "page") {
    return left.pageId === right.pageId;
  }
  if (left.kind === "database" && right.kind === "database") {
    return left.databaseId === right.databaseId;
  }
  if (left.kind === "canvas" && right.kind === "canvas") {
    return left.canvasId === right.canvasId;
  }
  return false;
}
