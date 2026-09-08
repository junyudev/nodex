import type { ContentAccessIdentity } from "../../shared/content-access-context";
import type { LibraryRouteTarget } from "../../shared/library-module";
import type { DocumentRecoveryScope } from "../../shared/block-documents/document-recovery";

export interface ContentEditLocation {
  readonly target: LibraryRouteTarget;
  readonly label: string;
}

export type ContentEditIssueAction =
  | {
      readonly kind: "run";
      readonly label: string;
      readonly run: () => unknown | Promise<unknown>;
      readonly confirmation?: {
        readonly title: string;
        readonly description: string;
        readonly confirmLabel: string;
      };
    }
  | {
      readonly kind: "review";
      readonly label: string;
      readonly scope: DocumentRecoveryScope;
      readonly documentId: string | null;
      readonly draftId?: string;
      readonly prepare?: () => Promise<void>;
      readonly exportLocal?: () => Promise<void>;
    };

/** An owner-authored problem, never a command queue or proof that other content is saved. */
export interface ContentEditIssue {
  readonly kind: "history" | "save" | "draft";
  readonly id: string;
  readonly scope: ContentAccessIdentity;
  readonly location: ContentEditLocation | null;
  readonly title: string;
  readonly detail: string;
  readonly actions: readonly ContentEditIssueAction[];
}

export const contentRecoveryIssueId = (
  scope: ContentAccessIdentity,
  storeEpoch: string,
  draftId: string,
): string => `${scope.libraryId}\0${storeEpoch}\0draft:${draftId}`;

export interface ContentEditIssueSource {
  getIssues(): readonly ContentEditIssue[];
  subscribe(listener: () => void): () => void;
}

/** Observation follows the source's lifetime; viewing problems never retains content. */
export function createContentEditIssueRegistry() {
  const sources = new Map<ContentEditIssueSource, { references: number; release: () => void }>();
  const listeners = new Set<() => void>();
  let issues: readonly ContentEditIssue[] = [];
  const publish = () => {
    // Only exact issue identities coalesce. Unrelated problems in one Project remain visible.
    const byId = new Map<string, ContentEditIssue>();
    for (const source of sources.keys()) {
      for (const issue of source.getIssues()) {
        const current = byId.get(issue.id);
        // The live failed replica can also offer Continue editing; keep those owner actions.
        if (!current || (current.kind === "draft" && issue.kind === "save"))
          byId.set(issue.id, issue);
      }
    }
    const next = [...byId.values()];
    if (next.length === issues.length && next.every((issue, index) => issue === issues[index]))
      return;
    issues = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => issues,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register: (source: ContentEditIssueSource) => {
      let entry = sources.get(source);
      if (!entry) {
        entry = { references: 0, release: source.subscribe(publish) };
        sources.set(source, entry);
      }
      const retained = entry;
      retained.references++;
      publish();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retained.references--;
        if (retained.references > 0) return;
        retained.release();
        sources.delete(source);
        publish();
      };
    },
  };
}

export const contentEditIssues = createContentEditIssueRegistry();
