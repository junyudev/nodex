import { expect, test } from "vite-plus/test";
import { bindLibraryDatabaseModuleReadV2 } from "./database-module-v2-transport";
});
  for (const invalid of [
    { ...work, extra: true },
  ])
});
  expect(
    bindLibraryDatabaseModuleReadV2({
      read: { target: { kind: "page", pageId: "page:a" }, mode: "blocking", window: { first: 1 } },
    }).read,
  ).toMatchObject({ mode: "blocking", target: { pageId: "page:a" }, window: { first: 1 } });
  expect(() =>
    bindLibraryDatabaseModuleReadV2({
      read: { target: { kind: "library" }, mode: "ready_work", limit: 101 },
    }),
  ).toThrow();
});
