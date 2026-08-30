import {
  executePageLifecycleIntentV2,
  type PageLifecycleExecutionResultV2,
  type PageLifecycleIntentV2,
  type PageLifecycleRuntimeDependenciesV2,
} from "../../shared/page-lifecycle-v2-runtime";
import { mutatePageLifecycle, readPageLifecyclePreflight } from "./api";
import { invokeRendererQuery as invoke } from "./renderer-command";
import type { DatabasePage } from "./types";

const defaultDependencies: PageLifecycleRuntimeDependenciesV2 = {
  readPreflight: readPageLifecyclePreflight,
  mutate: mutatePageLifecycle,
  readBoardProjection: async (projectId, pageId, minimumCommitCursor) =>
    (await invoke(
      "database-row:get",
      projectId,
      pageId,
      undefined,
      minimumCommitCursor,
    )) as DatabasePage | null,
  waitBeforeCanonicalReadRetry: async () => {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  },
};

export const commitPageLifecycleIntent = async (
  intent: PageLifecycleIntentV2,
  dependencies: PageLifecycleRuntimeDependenciesV2 = defaultDependencies,
): Promise<PageLifecycleExecutionResultV2> =>
  await executePageLifecycleIntentV2(intent, dependencies);
