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
  COMPOSER_PROMPT_DRAFTS_STORAGE_KEY,
  backfillComposerPromptAliases,
  buildComposerPromptAliases,
  readSessionComposerDraftExcerpt,
  composerPromptDraftsAtom,
  deserializeComposerPromptDraft,
  readComposerPromptDraft,
  serializeComposerPromptDraft,
  updateComposerPromptDrafts,
} from "./composer-draft-state";

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
    const aliases = buildComposerPromptAliases("app/client:pending/route/composer", "thread_real");
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
