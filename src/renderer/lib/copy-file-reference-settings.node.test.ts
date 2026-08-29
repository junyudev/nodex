import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  COPY_FILE_REFERENCES_AS_LOCAL_PATHS_STORAGE_KEY,
  readCopyFileReferencesAsLocalPaths,
  writeCopyFileReferencesAsLocalPaths,
} from "./copy-file-reference-settings";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
};
const storageGlobal = globalThis as unknown as { localStorage?: typeof storage };
let previousLocalStorage: typeof storage | undefined;

beforeEach(() => {
  previousLocalStorage = storageGlobal.localStorage;
  storageGlobal.localStorage = storage;
  values.clear();
});

afterEach(() => {
  if (previousLocalStorage) {
    storageGlobal.localStorage = previousLocalStorage;
    return;
  }
  delete storageGlobal.localStorage;
});

describe("copy file reference settings", () => {
  test("defaults to portable references", () => {
    expect(readCopyFileReferencesAsLocalPaths()).toBe(false);
  });

  test("persists the explicit local-path preference", () => {
    expect(writeCopyFileReferencesAsLocalPaths(true)).toBe(true);
    expect(values.get(COPY_FILE_REFERENCES_AS_LOCAL_PATHS_STORAGE_KEY)).toBe("true");
    expect(readCopyFileReferencesAsLocalPaths()).toBe(true);
  });
});
