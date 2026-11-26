export type FolderPlacement =
  | { readonly kind: "project"; readonly projectId: string; readonly name: string }
  | {
      readonly kind: "new-project";
      readonly projectId: string;
      readonly name: string;
      readonly root: string;
    }
  | { readonly kind: "chats" }
  | { readonly kind: "missing" };

export interface SortChatsDestination {
  readonly placement: Exclude<FolderPlacement, { kind: "missing" }>;
  readonly count: number;
}

export interface SortChatsPreview {
  readonly planId: string;
  readonly destinations: readonly SortChatsDestination[];
}

export interface SortChatsResult {
  readonly moved: number;
  readonly skipped: number;
}
