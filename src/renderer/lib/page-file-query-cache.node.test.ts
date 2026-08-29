import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "vite-plus/test";

import { queryKeys } from "./query-keys";
import { invalidateCachedPageFileQueries } from "./page-file-query-cache";

describe("Page File query cache", () => {
  test("invalidates retained Page File inventories across access contexts", async () => {
    const client = new QueryClient();
    const sourceProject = queryKeys.library.pageFilesWindow(
      { kind: "project", projectId: "project:one" },
      "page:source",
      "",
    );
    const sourceLibrary = queryKeys.library.pageFilesWindow(
      { kind: "library" },
      "page:source",
      "image",
    );
    const unrelated = queryKeys.library.pageFilesWindow(
      { kind: "project", projectId: "project:one" },
      "page:other",
      "",
    );
    client.setQueryData(sourceProject, { revision: 1 });
    client.setQueryData(sourceLibrary, { revision: 1 });
    client.setQueryData(unrelated, { revision: 1 });

    await invalidateCachedPageFileQueries(client, "page:source");

    expect(client.getQueryState(sourceProject)?.isInvalidated).toBe(true);
    expect(client.getQueryState(sourceLibrary)?.isInvalidated).toBe(true);
    expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
  });
});
