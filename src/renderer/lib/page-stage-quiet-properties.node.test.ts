import { describe, expect, test } from "vite-plus/test";

import {
  advancePageStageQuietPropertiesState,
  createPageStageQuietPropertiesState,
  formatPageStageQuietPropertyCountLabel,
  resolveLinkedChatsPropertySignal,
  resolvePageFilesPropertySignal,
  type PageStageQuietPropertiesInput,
} from "./page-stage-quiet-properties";

const input = (
  overrides: Partial<PageStageQuietPropertiesInput> = {},
): PageStageQuietPropertiesInput => ({
  pageId: "page-1",
  files: { signal: "quiet", manifestRevision: 1 },
  linkedChats: { signal: "quiet" },
  ...overrides,
});

describe("Page Stage quiet properties", () => {
  test("classifies only unplaced Files and populated linked Chats as informative", () => {
    expect(
      resolvePageFilesPropertySignal({ hasManifest: true, unplacedTotal: 0, hasError: false }),
    ).toBe("quiet");
    expect(
      resolvePageFilesPropertySignal({ hasManifest: true, unplacedTotal: 1, hasError: false }),
    ).toBe("informative");
    expect(resolveLinkedChatsPropertySignal({ count: 0, loading: false, hasError: false })).toBe(
      "quiet",
    );
    expect(resolveLinkedChatsPropertySignal({ count: 1, loading: false, hasError: false })).toBe(
      "informative",
    );
  });

  test("formats the shared quiet-property disclosure label", () => {
    expect(formatPageStageQuietPropertyCountLabel(1, false)).toBe("1 more property");
    expect(formatPageStageQuietPropertyCountLabel(2, true)).toBe("Hide 2 properties");
  });

  test("keeps quiet rows hidden and shows initially informative rows", () => {
    const quiet = createPageStageQuietPropertiesState(input());
    expect(quiet.files.visible).toBe(false);
    expect(quiet.linkedChats.visible).toBe(false);

    const informative = createPageStageQuietPropertiesState(
      input({
        files: { signal: "informative", manifestRevision: 1 },
        linkedChats: { signal: "informative" },
      }),
    );
    expect(informative.files.visible).toBe(true);
    expect(informative.linkedChats.visible).toBe(true);
  });

  test("does not promote Files for a body-placement-only change", () => {
    const quiet = createPageStageQuietPropertiesState(input());
    const placementChanged = advancePageStageQuietPropertiesState(
      quiet,
      input({ files: { signal: "informative", manifestRevision: 1 } }),
    );

    expect(placementChanged.files.visible).toBe(false);
  });

  test("promotes a newly unplaced File and keeps the row stable afterward", () => {
    const quiet = createPageStageQuietPropertiesState(input());
    const added = advancePageStageQuietPropertiesState(
      quiet,
      input({ files: { signal: "informative", manifestRevision: 2 } }),
    );
    const placed = advancePageStageQuietPropertiesState(
      added,
      input({ files: { signal: "quiet", manifestRevision: 2 } }),
    );

    expect(added.files.visible).toBe(true);
    expect(placed.files.visible).toBe(true);
  });

  test("keeps a populated linked Chats row visible after its last relation is removed", () => {
    const quiet = createPageStageQuietPropertiesState(input());
    const linked = advancePageStageQuietPropertiesState(
      quiet,
      input({ linkedChats: { signal: "informative" } }),
    );
    const removed = advancePageStageQuietPropertiesState(
      linked,
      input({ linkedChats: { signal: "quiet" } }),
    );

    expect(linked.linkedChats.visible).toBe(true);
    expect(removed.linkedChats.visible).toBe(true);
  });

  test("surfaces attention and resets sticky visibility for another Page", () => {
    const attention = advancePageStageQuietPropertiesState(
      createPageStageQuietPropertiesState(input()),
      input({
        files: { signal: "attention", manifestRevision: 1 },
        linkedChats: { signal: "attention" },
      }),
    );
    expect(attention.files.visible).toBe(true);
    expect(attention.linkedChats.visible).toBe(true);

    const nextPage = advancePageStageQuietPropertiesState(attention, input({ pageId: "page-2" }));
    expect(nextPage.files.visible).toBe(false);
    expect(nextPage.linkedChats.visible).toBe(false);
  });
});
