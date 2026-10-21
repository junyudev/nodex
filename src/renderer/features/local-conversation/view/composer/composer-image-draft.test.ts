import { afterEach, describe, expect, test } from "vite-plus/test";
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
  composerImageDraftsAtom,
  persistableComposerImages,
  restoreComposerImages,
  updateComposerImageDrafts,
  type ComposerImageAttachment,
} from "./composer-draft-state";

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
