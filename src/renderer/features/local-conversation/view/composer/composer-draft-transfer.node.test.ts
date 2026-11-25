import { describe, expect, test, vi, afterEach } from "vite-plus/test";
import {
  createComposerDraftTransfer,
  type ComposerPastedTextAttachment,
  COMPOSER_IMAGE_DRAFTS_STORAGE_KEY,
  COMPOSER_PROMPT_DRAFTS_STORAGE_KEY,
  composerImageDraftsAtom,
  composerPromptDraftsAtom,
  persistComposerDraftTransfer,
  readComposerPromptDocument,
  restoreComposerImages,
  updateComposerPromptDocumentDrafts,
  updateComposerPromptDrafts,
  type ComposerCompletedDraftSnapshot,
  type ComposerImageAttachment,
  type ComposerPromptDocument,
  persistableComposerImages,
  updateComposerImageDrafts,
  backfillComposerPromptAliases,
  buildComposerPromptAliases,
  readSessionComposerDraftExcerpt,
  deserializeComposerPromptDraft,
  readComposerPromptDraft,
  serializeComposerPromptDraft,
} from "./composer-draft-state";
import {
  prepareComposerDraftTransferAttachments,
  type ComposerDraftPastedTextPort,
} from "./composer-draft-transfer-attachments";
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

describe("composer draft transfer attachments", () => {
  function fixture() {
    const contents = new Map([["/source/notes.txt", "Exact source text\n原文"]]);
    let nextId = 0;
    const port = {
      read: vi.fn<ComposerDraftPastedTextPort["read"]>(async ({ file }) => {
        const text = contents.get(file.path);
        if (text === undefined) throw new Error("Source is unavailable");
        return text;
      }),
      create: vi.fn<ComposerDraftPastedTextPort["create"]>(async ({ text, hostId }) => {
        const path = `/copies/${++nextId}/notes.txt`;
        contents.set(path, text);
        return {
          file: { path, fsPath: path, label: "Pasted text", hostId },
          preview: "new preview",
          characterCount: text.length,
        };
      }),
      remove: vi.fn<ComposerDraftPastedTextPort["remove"]>(async ({ file }) => {
        contents.delete(file.path);
      }),
    };
    const pasted: ComposerPastedTextAttachment = {
      id: "pasted",
      status: "ready",
      preview: "Original preview",
      characterCount: 20,
      attachment: {
        file: { path: "/source/notes.txt", fsPath: "/source/notes.txt", label: "Original label" },
        preview: "Original preview",
        characterCount: 20,
      },
    };
    const transfer = createComposerDraftTransfer("target", {
      prompt: "Continue",
      fileAttachments: [],
      addedFiles: [],
      imageAttachments: [],
      appshotContexts: [],
      pastedTextAttachments: [pasted],
      commentAttachments: [],
      goalModeActive: false,
    });
    return { contents, port, pasted, transfer };
  }

  describe("independent pasted text in draft transfers", () => {
    test.each(["source", "destination"] as const)(
      "removing the %s file cannot invalidate the other draft",
      async (removed) => {
        const { contents, port, pasted, transfer } = fixture();
        const prepared = await prepareComposerDraftTransferAttachments(transfer, port, "local");
        const copied = prepared.transfer.pastedTextAttachments[0];
        if (pasted.status !== "ready" || copied?.status !== "ready")
          throw new Error("Expected ready pasted text");
        expect(copied).toEqual({
          ...pasted,
          attachment: {
            ...pasted.attachment,
            file: expect.objectContaining({ path: "/copies/1/notes.txt" }),
          },
        });
        expect(port.create).toHaveBeenCalledWith({
          text: "Exact source text\n原文",
          hostId: "local",
        });
        const files = { source: pasted.attachment.file, destination: copied.attachment.file };
        await port.remove({ file: files[removed] });
        expect(
          await port.read({ file: files[removed === "source" ? "destination" : "source"] }),
        ).toBe("Exact source text\n原文");
        expect(transfer.pastedTextAttachments).toEqual([pasted]);
        expect(contents.size).toBe(1);
      },
    );

    test("copies on the captured attachment's host and retains its exact preview metadata", async () => {
      const { port, transfer, pasted } = fixture();
      if (pasted.status !== "ready") throw new Error("Expected ready source");
      const remote = {
        ...transfer,
        pastedTextAttachments: [
          { ...pasted, attachment: { ...pasted.attachment, hostId: "remote-host" } },
        ],
      };
      const prepared = await prepareComposerDraftTransferAttachments(remote, port, "local");
      expect(port.read).toHaveBeenCalledWith({
        file: { ...pasted.attachment.file, hostId: "remote-host" },
      });
      expect(port.create).toHaveBeenCalledWith({
        text: "Exact source text\n原文",
        hostId: "remote-host",
      });
      expect(prepared.transfer.pastedTextAttachments[0]).toMatchObject({
        ...pasted,
        attachment: {
          hostId: "remote-host",
          file: {
            path: "/copies/1/notes.txt",
            fsPath: "/copies/1/notes.txt",
            hostId: "remote-host",
            label: "Original label",
          },
        },
      });
    });

    test.each(["read", "create"] as const)(
      "cleans only newly created files when a later %s fails",
      async (operation) => {
        const { contents, port, pasted, transfer } = fixture();
        const failure = new Error("Copy failed");
        // The first entry succeeds; the next invocation fails after allocating that copy.
        if (operation === "read")
          port.read
            .mockImplementationOnce(port.read.getMockImplementation()!)
            .mockRejectedValueOnce(failure);
        else
          port.create
            .mockImplementationOnce(port.create.getMockImplementation()!)
            .mockRejectedValueOnce(failure);
        const multiple = {
          ...transfer,
          pastedTextAttachments: [pasted, { ...pasted, id: "second" }],
        };
        await expect(
          prepareComposerDraftTransferAttachments(multiple, port, "local"),
        ).rejects.toThrow(failure);
        expect([...contents.keys()]).toEqual(["/source/notes.txt"]);
        expect(port.remove).toHaveBeenCalledExactlyOnceWith({
          file: expect.objectContaining({ path: "/copies/1/notes.txt" }),
        });
        expect(transfer.pastedTextAttachments).toEqual([pasted]);
      },
    );

    test("discards unclaimed copies once without ever deleting a source file", async () => {
      const { contents, port, transfer } = fixture();
      const prepared = await prepareComposerDraftTransferAttachments(transfer, port, "local");
      await prepared.discard();
      await prepared.discard();
      expect([...contents.keys()]).toEqual(["/source/notes.txt"]);
      expect(port.remove).toHaveBeenCalledTimes(1);
    });
  });
});

describe("composer draft transfer", () => {
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
      const event = {
        ...mutation,
        revision: this.snapshot.revision + 1,
        originRendererId: "writer",
      };
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
      {
        from: 17,
        to: 23,
        kind: "skill",
        id: "skill:review",
        label: "skill",
        path: "/skills/review",
      },
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
        restarted.jotaiStore.get(getConcretePersistedAtom(restarted, composerImageDraftsAtom))
          .value["local:target"] ?? [];
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
});

describe("composer image draft", () => {
  class MemoryTransport implements PersistedAtomTransport {
    snapshot: PersistedAtomSnapshot = { revision: 0, values: {} };
    readonly listeners = new Set<(event: PersistedAtomEvent) => void>();
    async readSnapshot(): Promise<PersistedAtomSnapshot> {
      return this.snapshot;
    }
    async mutate(mutation: PersistedAtomMutation): Promise<PersistedAtomEvent> {
      const event: PersistedAtomEvent = {
        ...mutation,
        revision: this.snapshot.revision + 1,
        originRendererId: "writer",
      };
      this.snapshot = {
        revision: event.revision,
        values: { ...this.snapshot.values, [event.key]: event.value },
      };
      for (const listener of this.listeners) listener(event);
      return event;
    }
    subscribe(listener: (event: PersistedAtomEvent) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
  }

  const stores: MaitaiStore[] = [];
  function createStore(transport: PersistedAtomTransport): MaitaiStore {
    const store = createMaitaiStore();
    stores.push(store);
    setMaitaiPersistenceTransport(store, transport);
    return store;
  }
  afterEach(() => {
    for (const store of stores.splice(0)) disposeMaitaiStore(store);
  });

  const attachment = (
    id: string,
    materialization: ComposerImageAttachment["materialization"],
    materializationStatus: ComposerImageAttachment["materializationStatus"] = "ready",
  ): ComposerImageAttachment => ({
    id,
    filename: `${id}.png`,
    mimeType: "image/png",
    src: "data:image/png;base64,iVBORw0KGgo=",
    origin: "paste",
    materialization,
    materializationStatus,
    uploadStatus: "idle",
    generation: 1,
  });

  describe("thread Composer image drafts", () => {
    test("keep only images already saved somewhere, and never their bytes", () => {
      const saved = persistableComposerImages([
        attachment("pasted", {
          hostId: "local",
          managedSource: "nodex://assets/pasted.png",
          localPath: "/home/media/pasted.png",
        }),
        attachment("picked", {
          hostId: "local",
          managedSource: null,
          localPath: "/Users/me/shot.png",
        }),
        attachment("saving", null, "pending"),
        attachment("unsaved", null, "failed"),
      ]);
      expect(saved).toEqual([
        {
          id: "pasted",
          filename: "pasted.png",
          mimeType: "image/png",
          hostId: "local",
          managedSource: "nodex://assets/pasted.png",
          localPath: "/home/media/pasted.png",
        },
        {
          id: "picked",
          filename: "picked.png",
          mimeType: "image/png",
          hostId: "local",
          managedSource: null,
          localPath: "/Users/me/shot.png",
        },
      ]);
      expect(JSON.stringify(saved)).not.toContain("base64");
    });

    test("come back after a renderer restart, shown and sent from where they were saved", async () => {
      const transport = new MemoryTransport();
      const aliases = ["composer:thread", "local:thread"];
      const first = createStore(transport);
      await preloadPersistedAtom(first, composerImageDraftsAtom);
      await first.jotaiStore.set(
        getConcretePersistedAtom(first, composerImageDraftsAtom),
        (current) =>
          updateComposerImageDrafts(
            current,
            aliases,
            persistableComposerImages([
              attachment("pasted", {
                hostId: "local",
                managedSource: "nodex://assets/pasted.png",
                localPath: null,
              }),
            ]),
          ),
      );
      disposeMaitaiStore(first);
      stores.splice(stores.indexOf(first), 1);

      const restarted = createStore(transport);
      await preloadPersistedAtom(restarted, composerImageDraftsAtom);
      const drafts = restarted.jotaiStore.get(
        getConcretePersistedAtom(restarted, composerImageDraftsAtom),
      ).value;
      const [image] = restoreComposerImages(drafts["local:thread"] ?? [], 0);
      expect(image).toMatchObject({
        id: "pasted",
        src: "nodex://assets/pasted.png",
        origin: "restored",
        materializationStatus: "ready",
        materialization: { hostId: "local", managedSource: "nodex://assets/pasted.png" },
      });
    });

    test("ignore saved entries that do not point at a saved image", async () => {
      const transport = new MemoryTransport();
      transport.snapshot = {
        revision: 1,
        values: {
          [COMPOSER_IMAGE_DRAFTS_STORAGE_KEY]: {
            "composer:thread": [
              {
                id: "web",
                filename: "a.png",
                mimeType: "image/png",
                hostId: "local",
                managedSource: "https://example.com/a.png",
                localPath: null,
              },
              {
                id: "relative",
                filename: "b.png",
                mimeType: "image/png",
                hostId: "local",
                managedSource: null,
                localPath: "b.png",
              },
              {
                id: "kept",
                filename: "c.png",
                mimeType: "image/png",
                hostId: "local",
                managedSource: "nodex://assets/c.png",
                localPath: null,
              },
            ],
          },
        },
      };
      const store = createStore(transport);
      await preloadPersistedAtom(store, composerImageDraftsAtom);
      const drafts = store.jotaiStore.get(
        getConcretePersistedAtom(store, composerImageDraftsAtom),
      ).value;
      expect(drafts["composer:thread"]?.map((image) => image.id)).toEqual(["kept"]);
    });
  });
});

describe("composer prompt draft atom", () => {
  class SharedPromptTransport implements PersistedAtomTransport {
    snapshot: PersistedAtomSnapshot = { revision: 0, values: {} };
    readonly listeners = new Set<(event: PersistedAtomEvent) => void>();

    async readSnapshot(): Promise<PersistedAtomSnapshot> {
      return this.snapshot;
    }

    async mutate(mutation: PersistedAtomMutation): Promise<PersistedAtomEvent> {
      const event: PersistedAtomEvent = {
        ...mutation,
        revision: this.snapshot.revision + 1,
        originRendererId: "writer",
      };
      this.snapshot = {
        revision: event.revision,
        values: { ...this.snapshot.values, [event.key]: event.value },
      };
      for (const listener of this.listeners) listener(event);
      return event;
    }

    subscribe(listener: (event: PersistedAtomEvent) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
  }

  const stores: MaitaiStore[] = [];

  function createPromptStore(transport: PersistedAtomTransport): MaitaiStore {
    const store = createMaitaiStore();
    stores.push(store);
    setMaitaiPersistenceTransport(store, transport);
    return store;
  }

  afterEach(() => {
    for (const store of stores.splice(0)) disposeMaitaiStore(store);
  });

  describe("composer prompt draft atom", () => {
    test("uses primary and local aliases and deletes both for an empty prompt", () => {
      expect(COMPOSER_PROMPT_DRAFTS_STORAGE_KEY).toBe("composer-prompt-drafts-v1");
      const aliases = buildComposerPromptAliases("app/thread/route/composer", "thread_1");
      expect(aliases).toEqual(["app/thread/route/composer", "local:thread_1"]);

      const written = updateComposerPromptDrafts({}, aliases, "keep semantic draft");
      expect(readComposerPromptDraft(written, aliases)).toBe("keep semantic draft");
      expect(Object.keys(written).sort()).toEqual([...aliases].sort());
      expect(updateComposerPromptDrafts(written, aliases, "")).toEqual({});
    });

    test("backfills the attached local alias without changing the stable pending identity", () => {
      const primaryOnly = updateComposerPromptDrafts(
        {},
        ["app/client:pending/route/composer"],
        "survives pending attachment",
      );
      const aliases = buildComposerPromptAliases(
        "app/client:pending/route/composer",
        "thread_real",
      );
      const attached = backfillComposerPromptAliases(primaryOnly, aliases);

      expect(readComposerPromptDraft(attached, aliases)).toBe("survives pending attachment");
      expect(attached[aliases[0] ?? ""]).toBe(attached[aliases[1] ?? ""]);
    });

    test("lets a root Session's row read its unsent prompt across thread attachment", () => {
      const draftAliases = buildComposerPromptAliases("app/draft:s1/route/composer", null, "s1");
      expect(draftAliases).toEqual(["app/draft:s1/route/composer", "session:s1"]);
      const typed = updateComposerPromptDrafts({}, draftAliases, "\n  Half a reply\nsecond line");
      expect(readSessionComposerDraftExcerpt(typed, "s1")).toBe("Half a reply");
      expect(readSessionComposerDraftExcerpt(typed, "s2")).toBeNull();

      // The first Turn attaches a thread; the Session alias keeps naming the same draft.
      const attachedAliases = buildComposerPromptAliases(
        "app/session:s1/route/composer",
        "thread_1",
        "s1",
      );
      const attached = backfillComposerPromptAliases(typed, attachedAliases);
      expect(readComposerPromptDraft(attached, attachedAliases)).toBe(
        "\n  Half a reply\nsecond line",
      );

      // Sending or erasing the prompt clears it for the row too.
      const cleared = updateComposerPromptDrafts(attached, attachedAliases, "");
      expect(readSessionComposerDraftExcerpt(cleared, "s1")).toBeNull();
      expect(
        readSessionComposerDraftExcerpt(
          updateComposerPromptDrafts(attached, attachedAliases, "   "),
          "s1",
        ),
      ).toBeNull();
    });

    test("round-trips link marks and semantic mention identities", () => {
      const document = {
        text: "Review docs with @Computer Use and thread A",
        links: [{ from: 7, to: 11, href: "https://example.com/docs" }],
        mentions: [
          {
            from: 17,
            to: 30,
            kind: "plugin" as const,
            id: "plugin:computer-use",
            label: "Computer Use",
            path: "/plugins/computer-use",
          },
          {
            from: 35,
            to: 43,
            kind: "thread" as const,
            id: "thread_1",
            label: "thread A",
          },
        ],
      };

      expect(deserializeComposerPromptDraft(serializeComposerPromptDraft(document))).toEqual(
        document,
      );
      expect(
        deserializeComposerPromptDraft(
          serializeComposerPromptDraft({
            text: "@Plugin Management",
            links: [],
            mentions: [
              {
                from: 0,
                to: 18,
                kind: "app",
                id: "app:plugin-management",
                label: "Plugin Management",
                path: "app://plugin-management",
              },
            ],
          }),
        ).mentions[0]?.kind,
      ).toBe("app");
      expect(deserializeComposerPromptDraft("legacy plain text").text).toBe("legacy plain text");
    });

    test("hydrates before exposing a durable baseline and restores after renderer restart", async () => {
      const transport = new SharedPromptTransport();
      const aliases = ["composer:restart"];
      transport.snapshot = {
        revision: 4,
        values: {
          [COMPOSER_PROMPT_DRAFTS_STORAGE_KEY]: updateComposerPromptDrafts(
            {},
            aliases,
            "restored baseline",
          ),
        },
      };
      const firstStore = createPromptStore(transport);
      const firstAtom = getConcretePersistedAtom(firstStore, composerPromptDraftsAtom);

      expect(firstStore.jotaiStore.get(firstAtom).status).toBe("loading");
      await preloadPersistedAtom(firstStore, composerPromptDraftsAtom);
      expect(readComposerPromptDraft(firstStore.jotaiStore.get(firstAtom).value, aliases)).toBe(
        "restored baseline",
      );

      await firstStore.jotaiStore.set(firstAtom, (current) =>
        updateComposerPromptDrafts(current, aliases, "edited before restart"),
      );
      disposeMaitaiStore(firstStore);
      stores.splice(stores.indexOf(firstStore), 1);

      const restartedStore = createPromptStore(transport);
      await preloadPersistedAtom(restartedStore, composerPromptDraftsAtom);
      const restartedAtom = getConcretePersistedAtom(restartedStore, composerPromptDraftsAtom);
      expect(
        readComposerPromptDraft(restartedStore.jotaiStore.get(restartedAtom).value, aliases),
      ).toBe("edited before restart");
    });

    test("publishes prompt edits across renderer windows", async () => {
      const transport = new SharedPromptTransport();
      const firstStore = createPromptStore(transport);
      const secondStore = createPromptStore(transport);
      await Promise.all([
        preloadPersistedAtom(firstStore, composerPromptDraftsAtom),
        preloadPersistedAtom(secondStore, composerPromptDraftsAtom),
      ]);
      const firstAtom = getConcretePersistedAtom(firstStore, composerPromptDraftsAtom);
      const secondAtom = getConcretePersistedAtom(secondStore, composerPromptDraftsAtom);
      const aliases = ["composer:shared"];

      await firstStore.jotaiStore.set(firstAtom, (current) =>
        updateComposerPromptDrafts(current, aliases, "other window draft"),
      );

      expect(readComposerPromptDraft(secondStore.jotaiStore.get(secondAtom).value, aliases)).toBe(
        "other window draft",
      );
    });
  });
});
