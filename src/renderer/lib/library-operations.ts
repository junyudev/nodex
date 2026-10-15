import type {
  LibraryPlacedResourceTarget,
  LibraryWriteParent,
  MoveLibraryBlockOperation,
} from "../../shared/library-module";

type LibraryMoveableResourceTarget = Exclude<
  LibraryPlacedResourceTarget,
  { readonly kind: "canvas" }
>;

export const buildLibraryMoveOperation = (
  input: Readonly<{
    target: LibraryMoveableResourceTarget;
    expectedLocationRevision: number;
    parent: LibraryWriteParent;
  }>,
): MoveLibraryBlockOperation => ({
  kind: "move_block",
  target:
    input.target.kind === "page"
      ? {
          kind: "page",
          pageId: input.target.pageId,
          expectedLocationRevision: input.expectedLocationRevision,
        }
      : {
          kind: "database",
          databaseId: input.target.databaseId,
          expectedLocationRevision: input.expectedLocationRevision,
        },
  parent: input.parent,
});
