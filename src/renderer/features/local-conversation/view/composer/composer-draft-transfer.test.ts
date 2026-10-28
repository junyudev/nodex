import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  PersistedAtomEvent,
  PersistedAtomMutation,
  PersistedAtomSnapshot,
} from "../../../../../shared/ipc-api";
import type { PersistedAtomTransport } from "@/lib/persisted-atom-store";
import {
  createMaitaiStore,
  disposeMaitaiStore,
  getConcretePersistedAtom,
  preloadPersistedAtom,
  setMaitaiPersistenceTransport,
  type MaitaiStore,
} from "@/lib/maitai";
import {
  COMPOSER_IMAGE_DRAFTS_STORAGE_KEY,
  COMPOSER_PROMPT_DRAFTS_STORAGE_KEY,
  composerImageDraftsAtom,
  composerPromptDraftsAtom,
  createComposerDraftTransfer,
  persistComposerDraftTransfer,
  readComposerPromptDocument,
  restoreComposerImages,
  updateComposerPromptDocumentDrafts,
  updateComposerPromptDrafts,
  type ComposerCompletedDraftSnapshot,
  type ComposerImageAttachment,
  type ComposerPromptDocument,
} from "./composer-draft-state";

class DraftTransport implements PersistedAtomTransport {
  snapshot: PersistedAtomSnapshot = { revision: 0, values: {} };
  readonly mutations: PersistedAtomMutation[] = [];
  beforeMutation?: (mutation: PersistedAtomMutation) => Promise<void>;
  readError?: Error;

  async readSnapshot(): Promise<PersistedAtomSnapshot> {
    if (this.readError) throw this.readError;
    return this.snapshot;
  }

  async mutate(mutation: PersistedAtomMutation): Promise<PersistedAtomEvent> {
    this.mutations.push(mutation);
    await this.beforeMutation?.(mutation);
    const event = { ...mutation, revision: this.snapshot.revision + 1, originRendererId: "writer" };
    this.snapshot = {
      revision: event.revision,
      values: { ...this.snapshot.values, [event.key]: event.value },
    };
    return event;
  }

  subscribe(): () => void {
    return () => {};
  }
}

const stores: MaitaiStore[] = [];
function createStore(transport: DraftTransport): MaitaiStore {
  const store = createMaitaiStore();
  stores.push(store);
  setMaitaiPersistenceTransport(store, transport);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) disposeMaitaiStore(store);
});

const document: ComposerPromptDocument = {
  text: "Review docs with @skill",
  links: [{ from: 7, to: 11, href: "https://example.com/docs" }],
  mentions: [
    { from: 17, to: 23, kind: "skill", id: "skill:review", label: "skill", path: "/skills/review" },
  ],
};

const image: ComposerImageAttachment = {
  id: "saved-image",
  filename: "context.png",
  mimeType: "image/png",
  src: "nodex://assets/context.png",
  origin: "browser",
  materialization: {
    hostId: "local",
    managedSource: "nodex://assets/context.png",
    localPath: null,
  },
  materializationStatus: "ready",
  uploadStatus: "idle",
  generation: 1,
};

const snapshot = (
  overrides: Partial<ComposerCompletedDraftSnapshot> = {},
): ComposerCompletedDraftSnapshot => ({
  prompt: document.text,
  promptDocument: document,
  fileAttachments: [
    {
      uiId: "file",
      attachment: {
        label: "source.ts",
        path: "source.ts",
        fsPath: "/work/source.ts",
        hostId: "local",
      },
    },
  ],
  addedFiles: [],
  imageAttachments: [image],
  appshotContexts: [],
  pastedTextAttachments: [
    {
      id: "pasted",
      status: "ready",
      preview: "notes",
      characterCount: 5,
      attachment: {
        preview: "notes",
        characterCount: 5,
        file: { label: "notes.txt", path: "notes.txt", fsPath: "/work/notes.txt" },
      },
    },
  ],
  commentAttachments: [],
  browserAnnotationAttachments: [
    {
      schemaVersion: 1,
      id: "annotation",
      browserTabId: "tab",
      createdAt: 1,
      note: "Review this",
      pageTitle: "Docs",
      pageUrl: "https://example.com/docs",
      anchors: [
        {
          id: "anchor",
          kind: "text",
          pageUrl: "https://example.com/docs",
          textExcerpt: "example",
          rect: { x: 1, y: 2, width: 3, height: 4 },
        },
      ],
    },
  ],
  goalModeActive: false,
  ...overrides,
});

describe("composer draft transfers", () => {
  test("keeps rich metadata and every ready attachment intact", () => {
    const captured = snapshot();
    const transfer = createComposerDraftTransfer(" target ", captured);
    expect(transfer).toEqual({
      ...captured,
      targetConversationId: "target",
      transferId: expect.any(String),
    });
    const drafts = updateComposerPromptDocumentDrafts(
      { untouched: "existing" },
      ["primary", "local:target"],
      document,
    );
    expect(readComposerPromptDocument(drafts, ["missing", "local:target"])).toEqual(document);
    expect(drafts.untouched).toBe("existing");
    expect(
      updateComposerPromptDocumentDrafts(drafts, ["primary", "local:target"], {
        text: "",
        links: [],
        mentions: [],
      }),
    ).toEqual({ untouched: "existing" });
  });

  test.each(["pending", "failed"] as const)(
    "blocks %s pasted text instead of dropping it",
    (status) => {
      const pasted = {
        id: "pasted",
        preview: "notes",
        characterCount: 5,
        generation: 1,
        status,
        error: "Could not save",
      };
      expect(() =>
        createComposerDraftTransfer("target", snapshot({ pastedTextAttachments: [pasted] })),
      ).toThrow(/pasted text attachments/);
    },
  );

  test.each([
    { materializationStatus: "pending" as const },
    { materializationStatus: "failed" as const },
    { materialization: null },
    { uploadStatus: "uploading" as const },
    { uploadStatus: "failed" as const },
  ])("blocks images that have not finished processing: %j", (state) => {
    expect(() =>
      createComposerDraftTransfer(
        "target",
        snapshot({ imageAttachments: [{ ...image, ...state }] }),
      ),
    ).toThrow(/image attachments/);
  });

  test("persists rich text and saved images under only the target alias across restart", async () => {
    const transport = new DraftTransport();
    const sourcePrompt = updateComposerPromptDrafts(
      {},
      ["composer:source", "local:source"],
      "source draft",
    );
    const sourceImages = {
      "local:source": [
        {
          id: "source-image",
          filename: "source.png",
          mimeType: "image/png",
          hostId: "local",
          managedSource: "nodex://assets/source.png",
          localPath: null,
        },
      ],
    };
    transport.snapshot = {
      revision: 1,
      values: {
        [COMPOSER_PROMPT_DRAFTS_STORAGE_KEY]: sourcePrompt,
        [COMPOSER_IMAGE_DRAFTS_STORAGE_KEY]: sourceImages,
      },
    };
    const first = createStore(transport);
    await persistComposerDraftTransfer(first, createComposerDraftTransfer("target", snapshot()));
    const savedPrompts = transport.snapshot.values[COMPOSER_PROMPT_DRAFTS_STORAGE_KEY];
    const savedImages = transport.snapshot.values[COMPOSER_IMAGE_DRAFTS_STORAGE_KEY];
    expect(savedPrompts).toMatchObject(sourcePrompt);
    expect(savedImages).toMatchObject(sourceImages);
    expect(Object.keys(savedPrompts as object).sort()).toEqual([
      "composer:source",
      "local:source",
      "local:target",
    ]);
    expect(Object.keys(savedImages as object).sort()).toEqual(["local:source", "local:target"]);
    disposeMaitaiStore(first);
    stores.splice(stores.indexOf(first), 1);
    const restarted = createStore(transport);
    await Promise.all([
      preloadPersistedAtom(restarted, composerPromptDraftsAtom),
      preloadPersistedAtom(restarted, composerImageDraftsAtom),
    ]);
    expect(
      readComposerPromptDocument(
        restarted.jotaiStore.get(getConcretePersistedAtom(restarted, composerPromptDraftsAtom))
          .value,
        ["local:target"],
      ),
    ).toEqual(document);
    const images =
      restarted.jotaiStore.get(getConcretePersistedAtom(restarted, composerImageDraftsAtom)).value[
        "local:target"
      ] ?? [];
    expect(restoreComposerImages(images, 2)).toMatchObject([
      { id: image.id, materialization: image.materialization, materializationStatus: "ready" },
    ]);
  });

  test("waits for both durable writes and supports plain prompt snapshots", async () => {
    const transport = new DraftTransport();
    let finishImage!: () => void;
    const imageWrite = new Promise<void>((resolve) => {
      finishImage = resolve;
    });
    transport.beforeMutation = (mutation) =>
      mutation.key === COMPOSER_IMAGE_DRAFTS_STORAGE_KEY ? imageWrite : Promise.resolve();
    const completed = vi.fn();
    const { promptDocument: _document, ...plain } = snapshot();
    const saving = persistComposerDraftTransfer(
      createStore(transport),
      createComposerDraftTransfer("target", plain),
    ).then(completed);
    await vi.waitFor(() => expect(transport.mutations).toHaveLength(2));
    expect(completed).not.toHaveBeenCalled();
    finishImage();
    await saving;
    expect(completed).toHaveBeenCalledTimes(1);
    const prompts = transport.snapshot.values[COMPOSER_PROMPT_DRAFTS_STORAGE_KEY] as Record<
      string,
      string
    >;
    expect(readComposerPromptDocument(prompts, ["local:target"])).toEqual({
      text: document.text,
      links: [],
      mentions: [],
    });
  });

  test.each(["text", "images"] as const)(
    "preserves an edited destination %s draft and the source instead of overwriting it",
    async (field) => {
      const transport = new DraftTransport();
      const prompts = updateComposerPromptDocumentDrafts(
        updateComposerPromptDrafts({}, ["local:source"], "source draft"),
        ["local:target"],
        field === "text" ? { text: "Edited saved draft", links: [], mentions: [] } : document,
      );
      const images = {
        "local:target": [
          {
            id: field === "images" ? "edited-image" : image.id,
            filename: image.filename,
            mimeType: image.mimeType,
            hostId: "local",
            managedSource: "nodex://assets/context.png",
            localPath: null,
          },
        ],
      };
      transport.snapshot = {
        revision: 1,
        values: {
          [COMPOSER_PROMPT_DRAFTS_STORAGE_KEY]: prompts,
          [COMPOSER_IMAGE_DRAFTS_STORAGE_KEY]: images,
        },
      };
      await expect(
        persistComposerDraftTransfer(
          createStore(transport),
          createComposerDraftTransfer("target", snapshot()),
        ),
      ).rejects.toThrow(/saved conversation's .*changed/);
      expect(transport.mutations).toEqual([]);
      expect(transport.snapshot.values[COMPOSER_PROMPT_DRAFTS_STORAGE_KEY]).toEqual(prompts);
      expect(transport.snapshot.values[COMPOSER_IMAGE_DRAFTS_STORAGE_KEY]).toEqual(images);
    },
  );

  test("completes an identical partial transfer and allows an identical retry", async () => {
    const transport = new DraftTransport();
    transport.snapshot = {
      revision: 1,
      values: {
        [COMPOSER_PROMPT_DRAFTS_STORAGE_KEY]: updateComposerPromptDocumentDrafts(
          {},
          ["local:target"],
          document,
        ),
      },
    };
    const store = createStore(transport);
    const transfer = createComposerDraftTransfer("target", snapshot());
    await persistComposerDraftTransfer(store, transfer);
    const saved = transport.snapshot.values;
    await persistComposerDraftTransfer(store, transfer);
    expect(transport.snapshot.values).toEqual(saved);
    expect(transport.snapshot.values[COMPOSER_IMAGE_DRAFTS_STORAGE_KEY]).toMatchObject({
      "local:target": [expect.objectContaining({ id: image.id })],
    });
  });

  test("rejects file-id-only images before writing either draft", async () => {
    const transport = new DraftTransport();
    const transfer = createComposerDraftTransfer(
      "target",
      snapshot({
        imageAttachments: [
          {
            ...image,
            materialization: {
              hostId: "local",
              localPath: null,
              managedSource: null,
              fileId: "file:image",
            },
          },
        ],
      }),
    );
    await expect(persistComposerDraftTransfer(createStore(transport), transfer)).rejects.toThrow(
      /saved locally/,
    );
    expect(transport.mutations).toEqual([]);
  });

  test("keeps source drafts safe when their durable baseline cannot be read", async () => {
    const transport = new DraftTransport();
    transport.readError = new Error("Draft storage unavailable");
    await expect(
      persistComposerDraftTransfer(
        createStore(transport),
        createComposerDraftTransfer("target", snapshot()),
      ),
    ).rejects.toThrow("Draft storage unavailable");
    expect(transport.mutations).toEqual([]);
  });

  test("reports persistence failures instead of publishing an undurable transfer", async () => {
    const transport = new DraftTransport();
    transport.beforeMutation = async () => {
      throw new Error("Write failed");
    };
    await expect(
      persistComposerDraftTransfer(
        createStore(transport),
        createComposerDraftTransfer("target", snapshot()),
      ),
    ).rejects.toThrow("Write failed");
    expect(transport.mutations).toHaveLength(2);
  });
});
