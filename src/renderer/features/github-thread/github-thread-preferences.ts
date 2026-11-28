import {
  persistedAtom,
  usePersistedAtomValue,
  useSetPersistedAtom,
  type PersistedAtomDefinition,
} from "@/lib/maitai";
import { GITHUB_ACTIVITY_FILTERS, type GitHubActivityFilter } from "./github-thread-model";

/** How a reader likes GitHub activity, kept for every GitHub tab in every window. */
const activityFilterAtom = persistedAtom<GitHubActivityFilter>({
  debugLabel: "github-thread-activity-filter",
  storageKey: "nodex:github-thread-activity-filter:v1",
  defaultValue: "all",
  hydration: "eager",
  decode: (value) =>
    GITHUB_ACTIVITY_FILTERS.includes(value as GitHubActivityFilter)
      ? (value as GitHubActivityFilter)
      : "all",
});

/** Whether Files shows the changed files as a tree beside the diffs. */
const fileTreeOpenAtom = persistedAtom<boolean>({
  debugLabel: "github-thread-file-tree-open",
  storageKey: "nodex:github-thread-file-tree-open:v1",
  defaultValue: true,
  hydration: "eager",
  decode: (value) => value !== false,
});

function usePreference<Value>(atom: PersistedAtomDefinition<Value>) {
  const { value } = usePersistedAtomValue(atom);
  const write = useSetPersistedAtom(atom);
  const set = (next: Value) => {
    void write(next).catch(() => {
      // The choice stays applied for this window; the next change retries the write.
    });
  };
  return [value, set] as const;
}

export function useGitHubActivityFilter() {
  return usePreference(activityFilterAtom);
}

export function useGitHubFileTreeOpen() {
  return usePreference(fileTreeOpenAtom);
}
