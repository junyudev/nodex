import { describe, expect, test } from "vite-plus/test";
import {
  areGeneratedImageLiveGroupsEqual,
  beginOptimisticGeneratedImageEdit,
  getGeneratedImageLiveCollectionSnapshot,
  projectGeneratedImageCanonicalGroups,
  replaceGeneratedImageCanonicalGroups,
  replaceGeneratedImageLiveGroup,
} from "./generated-image-collection-store";
import type { GeneratedImageDescriptor } from "../model/types";

function image(id: string): GeneratedImageDescriptor {
  return {
    id,
    alt: id,
    attachmentSrc: `data:image/png;base64,${id}`,
    generatedOrdinal: 0,
    groupId: "unused",
    source: "generated",
    src: `data:image/png;base64,${id}`,
    status: "ready",
  };
}

describe("generated image live collection store", () => {
  test("merges mounted turn groups and projects pending placeholders", () => {
    const removeLater = replaceGeneratedImageLiveGroup("thread", {
      id: "later",
      images: [image("second")],
      pendingImageCount: 1,
      turnStartedAtMs: 200,
    });
    const removeEarlier = replaceGeneratedImageLiveGroup("thread", {
      id: "earlier",
      images: [image("first")],
      pendingImageCount: 0,
      turnStartedAtMs: 100,
    });

    const snapshot = getGeneratedImageLiveCollectionSnapshot("thread");
    expect(snapshot.groups.map((group) => group.id)).toEqual(["earlier", "later"]);
    expect(snapshot.images.map((item) => [item.id, item.generatedOrdinal, item.status])).toEqual([
      ["first", 1, "ready"],
      ["second", 2, "ready"],
      ["later:pending:0", 3, "loading"],
    ]);

    removeEarlier();
    removeLater();
    expect(getGeneratedImageLiveCollectionSnapshot("thread").images).toEqual([]);
  });

  test("ignores stale cleanup after a group update", () => {
    const removeStale = replaceGeneratedImageLiveGroup("thread-update", {
      id: "turn",
      images: [image("old")],
      pendingImageCount: 0,
      turnStartedAtMs: 1,
    });
    const removeCurrent = replaceGeneratedImageLiveGroup("thread-update", {
      id: "turn",
      images: [image("new")],
      pendingImageCount: 0,
      turnStartedAtMs: 1,
    });

    removeStale();
    expect(getGeneratedImageLiveCollectionSnapshot("thread-update").images[0]?.id).toBe("new");
    removeCurrent();
  });

  test("keeps canonical virtualized groups alongside a mounted live group", () => {
    const removeCanonical = replaceGeneratedImageCanonicalGroups("thread-canonical", [
      {
        id: "historic",
        images: [image("historic-image")],
        pendingImageCount: 0,
        turnStartedAtMs: 1,
      },
    ]);
    const removeMounted = replaceGeneratedImageLiveGroup("thread-canonical", {
      id: "live",
      images: [image("live-image")],
      pendingImageCount: 1,
      turnStartedAtMs: 2,
    });

    expect(
      getGeneratedImageLiveCollectionSnapshot("thread-canonical").groups.map((group) => group.id),
    ).toEqual(["historic", "live"]);
    removeMounted();
    removeCanonical();
    expect(getGeneratedImageLiveCollectionSnapshot("thread-canonical")).toMatchObject({
      groups: [],
      images: [],
    });
  });

  test("preserves canonical conversation order when timestamps collide or regress", () => {
    const removeCanonical = replaceGeneratedImageCanonicalGroups("thread-canonical-order", [
      {
        id: "first-in-thread",
        images: [image("first")],
        pendingImageCount: 0,
        turnStartedAtMs: 200,
      },
      {
        id: "second-in-thread",
        images: [image("second")],
        pendingImageCount: 0,
        turnStartedAtMs: 100,
      },
    ]);

    expect(
      getGeneratedImageLiveCollectionSnapshot("thread-canonical-order").groups.map(
        (group) => group.id,
      ),
    ).toEqual(["first-in-thread", "second-in-thread"]);
    removeCanonical();
  });

  test("restores the previous registration after overlapping groups unmount", () => {
    const removeOld = replaceGeneratedImageLiveGroup("thread-overlap", {
      id: "turn",
      images: [image("old")],
      pendingImageCount: 0,
      turnStartedAtMs: 1,
    });
    const removeNew = replaceGeneratedImageLiveGroup("thread-overlap", {
      id: "turn",
      images: [image("new")],
      pendingImageCount: 0,
      turnStartedAtMs: 1,
    });

    removeNew();
    expect(getGeneratedImageLiveCollectionSnapshot("thread-overlap").images[0]?.id).toBe("old");
    removeOld();
  });

  test("projects generated turn output into stable canonical group identity", () => {
    const groups = projectGeneratedImageCanonicalGroups({
      threadId: "thread-projection",
      projectId: null,
      forkedFromId: null,
      source: null,
      modelProvider: "openai",
      threadName: "Launch concepts",
      threadPreview: "",
      cwd: null,
      statusType: "idle",
      statusActiveFlags: [],
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      linkedAt: "",
      resumeState: "idle",
      requests: [],
      queuedFollowUps: {
        status: "ready",
        ledgerRevision: 0,
        projectionRevision: 0,
        entries: [],
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      },
      pendingSteers: [],
      backgroundTerminalRows: [],
      capabilityFlags: {},
      turns: [
        {
          threadId: "thread-projection",
          turnId: "turn-1",
          status: "completed",
          itemIds: ["image-1"],
          items: [
            {
              threadId: "thread-projection",
              turnId: "turn-1",
              itemId: "image-1",
              type: "generatedImage",
              kind: "toolCall",
              generatedImage: {
                src: "data:image/png;base64,projection",
                status: "completed",
              },
              createdAt: 10,
              updatedAt: 10,
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof projectGeneratedImageCanonicalGroups>[0]);

    expect(groups[0]?.id).toBe("turn-1:generated-image-gallery");
    expect(groups[0]?.images[0]?.attachmentId).toBe("image-playground:image-1");
    expect(groups[0]?.images[0]?.tabTitle).toBe("Launch concepts - Generated image 1");
    expect(areGeneratedImageLiveGroupsEqual(groups, groups)).toBe(true);
  });

  test("rolls back or replaces optimistic generated-edit placeholders", () => {
    const removeInitial = replaceGeneratedImageLiveGroup("thread-optimistic", {
      id: "initial",
      images: [image("before")],
      pendingImageCount: 0,
      turnStartedAtMs: 1,
    });
    const rolledBack = beginOptimisticGeneratedImageEdit("thread-optimistic");
    expect(rolledBack).not.toBeNull();
    expect(
      getGeneratedImageLiveCollectionSnapshot("thread-optimistic").images.at(-1),
    ).toMatchObject({ id: rolledBack?.id, loading: true, status: "loading" });
    rolledBack?.rollback();
    expect(
      getGeneratedImageLiveCollectionSnapshot("thread-optimistic").images.map((item) => item.id),
    ).toEqual(["before"]);

    const replaced = beginOptimisticGeneratedImageEdit("thread-optimistic");
    expect(replaced).not.toBeNull();
    const removeReplacement = replaceGeneratedImageLiveGroup("thread-optimistic", {
      id: "replacement",
      images: [
        {
          ...image("after"),
          turnStartedAtMs: (replaced?.createdAtMs ?? 0) + 1,
        },
      ],
      pendingImageCount: 0,
      turnStartedAtMs: (replaced?.createdAtMs ?? 0) + 1,
    });
    expect(
      getGeneratedImageLiveCollectionSnapshot("thread-optimistic").images.map((item) => item.id),
    ).toEqual(["before", "after"]);

    removeReplacement();
    removeInitial();
  });

  test("does not let newly mounted history claim an optimistic live-tail edit", () => {
    const threadId = "thread-optimistic-history";
    const liveBefore = {
      id: "live",
      images: [image("before")],
      pendingImageCount: 0,
      turnStartedAtMs: 2,
    };
    const removeInitial = replaceGeneratedImageCanonicalGroups(threadId, [liveBefore]);
    const optimistic = beginOptimisticGeneratedImageEdit(threadId);
    expect(optimistic).not.toBeNull();

    const historic = {
      id: "historic",
      images: [image("history-loaded-late")],
      pendingImageCount: 0,
      turnStartedAtMs: 1,
    };
    const removeHistory = replaceGeneratedImageCanonicalGroups(threadId, [historic, liveBefore]);
    expect(getGeneratedImageLiveCollectionSnapshot(threadId).images.at(-1)?.id).toBe(
      optimistic?.id,
    );

    const removeReady = replaceGeneratedImageCanonicalGroups(threadId, [
      historic,
      { ...liveBefore, images: [...liveBefore.images, image("after")] },
    ]);
    expect(getGeneratedImageLiveCollectionSnapshot(threadId).images.map((item) => item.id)).toEqual(
      ["history-loaded-late", "before", "after"],
    );

    removeReady();
    removeHistory();
    removeInitial();
    optimistic?.rollback();
  });
});

describe("native image asset identity", () => {
  test("shares one native asset across canonical history and independent repeated receipts", () => {
    const threadId = "thread-native-receipts";
    const canonicalImage = {
      ...image("native"),
      alt: "Generated image 4",
      tabTitle: "Thread - Generated image 4",
    };
    const removeCanonical = replaceGeneratedImageCanonicalGroups(threadId, [
      { id: "canonical", images: [canonicalImage], pendingImageCount: 0, turnStartedAtMs: 1 },
    ]);
    const receipt = (id: string) => ({
      id,
      images: [image("native")],
      pendingImageCount: 0,
      nativeItemIds: ["native"],
      turnStartedAtMs: 1,
    });
    const removeFirst = replaceGeneratedImageLiveGroup(threadId, receipt("first"));
    const removeSecond = replaceGeneratedImageLiveGroup(threadId, receipt("second"));
    try {
      expect(
        getGeneratedImageLiveCollectionSnapshot(threadId).groups.map((group) => group.id),
      ).toEqual(["first", "second"]);
      expect(getGeneratedImageLiveCollectionSnapshot(threadId).images).toHaveLength(1);
      expect(getGeneratedImageLiveCollectionSnapshot(threadId).images[0]).toMatchObject({
        id: "native",
        alt: canonicalImage.alt,
        tabTitle: canonicalImage.tabTitle,
      });
      removeFirst();
      expect(getGeneratedImageLiveCollectionSnapshot(threadId).images).toHaveLength(1);
      expect(getGeneratedImageLiveCollectionSnapshot(threadId).images[0]?.groupId).toBe("second");
      removeSecond();
      expect(getGeneratedImageLiveCollectionSnapshot(threadId).images[0]?.groupId).toBe(
        "canonical",
      );
    } finally {
      removeFirst();
      removeSecond();
      removeCanonical();
    }
    expect(getGeneratedImageLiveCollectionSnapshot(threadId).images).toEqual([]);
  });

  test("retains pending native identity through completion and releases stale canonical pending state", () => {
    const threadId = "thread-native-transition";
    const removeCanonical = replaceGeneratedImageCanonicalGroups(threadId, [
      {
        id: "canonical",
        images: [],
        pendingImageCount: 1,
        pendingImageIds: ["native"],
        turnStartedAtMs: 1,
      },
    ]);
    const pending = {
      id: "receipt",
      images: [],
      pendingImageCount: 1,
      pendingImageIds: ["native"],
      nativeItemIds: ["native"],
      turnStartedAtMs: 1,
    };
    const removePending = replaceGeneratedImageLiveGroup(threadId, pending);
    expect(
      getGeneratedImageLiveCollectionSnapshot(threadId).images.map((item) => [
        item.id,
        item.status,
      ]),
    ).toEqual([["native", "loading"]]);
    const removeReady = replaceGeneratedImageLiveGroup(threadId, {
      ...pending,
      images: [image("native")],
      pendingImageCount: 0,
      pendingImageIds: [],
    });
    try {
      removePending();
      expect(
        getGeneratedImageLiveCollectionSnapshot(threadId).images.map((item) => [
          item.id,
          item.status,
        ]),
      ).toEqual([["native", "ready"]]);
      const failed = replaceGeneratedImageLiveGroup(threadId, {
        ...pending,
        images: [],
        pendingImageCount: 0,
        pendingImageIds: [],
      });
      try {
        expect(getGeneratedImageLiveCollectionSnapshot(threadId).images).toEqual([]);
      } finally {
        failed();
      }
    } finally {
      removeReady();
      removePending();
      removeCanonical();
    }
    expect(
      areGeneratedImageLiveGroupsEqual([pending], [{ ...pending, pendingImageIds: ["other"] }]),
    ).toBe(false);
  });
});
