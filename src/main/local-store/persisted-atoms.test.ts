import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { rename } from "node:fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { PersistedAtomStore } from "./persisted-atoms";
import {
  AGENT_RUNTIME_COMPOSER_CHOICES_STORAGE_KEY,
  AGENT_RUNTIME_MODEL_OPTIONS_STORAGE_KEY,
  AGENT_RUNTIME_NEW_CHAT_CHOICE_STORAGE_KEY,
  AgentRuntimeComposerChoiceSchema,
} from "../../shared/agent-runtime-composer-choice-storage";
import { legacyAgentInstanceId } from "../../shared/agents/legacy-identity";
import { spaceStorageKeyFor } from "../../shared/space-personal-state";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

async function withTempStore<T>(
  callback: (store: PersistedAtomStore, atomsPath: string) => Promise<T> | T,
): Promise<T> {
  const storeDir = mkdtempSync(join(tmpdir(), "nodex-persisted-atoms-"));
  const atomsPath = join(storeDir, "persisted-atoms-v1.json");
  const store = new PersistedAtomStore(atomsPath);
  try {
    return await callback(store, atomsPath);
  } finally {
    // A write still running when a test fails must not land in a removed directory.
    await store.whenDurable().catch(() => undefined);
    rmSync(storeDir, { recursive: true, force: true });
  }
}

const readFile = (atomsPath: string): unknown => JSON.parse(readFileSync(atomsPath, "utf8"));

afterEach(() => {
  vi.mocked(rename).mockClear();
});

describe("persisted atom local store", () => {
  test("durably rekeys ACP Composer drafts, new chat defaults and model option memory", async () => {
    await withTempStore(async (store, atomsPath) => {
      const oldId = "0e09b4cb-93f2-4137-b171-43cd32579819";
      const id = legacyAgentInstanceId("acp", oldId);
      const options = [{ id: "thinking", value: "medium" }];
      const selection = {
        binding: { driver: "acpRegistry", instanceId: oldId },
        model: "native/model",
        options,
      };
      const otherSelection = { binding: { driver: "codex", instanceId: "codex" }, model: oldId };
      const teamKey = spaceStorageKeyFor(
        { spaceId: "team", memberId: "member" },
        AGENT_RUNTIME_NEW_CHAT_CHOICE_STORAGE_KEY,
      );
      const state = {
        [AGENT_RUNTIME_COMPOSER_CHOICES_STORAGE_KEY]: {
          draft: { selection, runtimeMode: "full-access" },
          otherDraft: { selection: otherSelection },
        },
        [AGENT_RUNTIME_MODEL_OPTIONS_STORAGE_KEY]: { [oldId]: { [selection.model]: options } },
        [AGENT_RUNTIME_NEW_CHAT_CHOICE_STORAGE_KEY]: selection,
        [teamKey]: selection,
        unrelated: { instanceId: oldId },
      };
      writeFileSync(atomsPath, JSON.stringify(state));
      const migratedSelection = { ...selection, binding: { ...selection.binding, instanceId: id } };
      const expected = {
        ...state,
        [AGENT_RUNTIME_COMPOSER_CHOICES_STORAGE_KEY]: {
          draft: { selection: migratedSelection, runtimeMode: "full-access" },
          otherDraft: { selection: otherSelection },
        },
        [AGENT_RUNTIME_MODEL_OPTIONS_STORAGE_KEY]: { [id]: { [selection.model]: options } },
        [AGENT_RUNTIME_NEW_CHAT_CHOICE_STORAGE_KEY]: migratedSelection,
        [teamKey]: migratedSelection,
      };
      const snapshot = store.readSnapshot();
      expect(snapshot.values).toEqual(expected);
      expect(
        AgentRuntimeComposerChoiceSchema.parse(
          expected[AGENT_RUNTIME_COMPOSER_CHOICES_STORAGE_KEY].draft,
        ).selection,
      ).toEqual(migratedSelection);
      await store.whenDurable(snapshot.revision);
      expect(readFile(atomsPath)).toEqual(expected);
      expect(new PersistedAtomStore(atomsPath).readSnapshot()).toEqual({
        revision: 0,
        values: expected,
      });
    });
  });

  test("delivers committed updates and batch deletion once, without letting delivery fail a commit", async () => {
    await withTempStore(async (store, atomsPath) => {
      const events: Array<{ key: string; value: unknown; revision: number }> = [];
      const stopFailing = store.subscribe(() => {
        throw new Error("delivery offline");
      });
      const stop = store.subscribe((event) => events.push(event));
      store.update({ key: "state", value: { selected: 1 } });
      store.update({ key: "interactions", value: { annotation: 2 } });
      expect(store.removeAtoms(["state", "interactions"], "delete", null)).toHaveLength(2);
      expect(events.map(({ key, revision }) => ({ key, revision }))).toEqual([
        { key: "state", revision: 1 },
        { key: "interactions", revision: 2 },
        { key: "state", revision: 3 },
        { key: "interactions", revision: 4 },
      ]);
      expect(events.slice(-2).map((event) => event.value)).toEqual([undefined, undefined]);
      await store.whenDurable();
      expect(readFile(atomsPath)).toEqual({});
      stop();
      stopFailing();
      store.update({ key: "other", value: 3 });
      expect(events).toHaveLength(4);
    });
  });

  test("undefined mutation deletes a key in both the durable file and live inventory", async () => {
    await withTempStore(async (store, atomsPath) => {
      store.update({ key: "state", value: { selected: 1 } });
      store.update({ key: "state", value: undefined });
      expect(Object.hasOwn(store.readState(), "state")).toBe(false);
      await store.whenDurable();
      expect(Object.hasOwn(readFile(atomsPath) as object, "state")).toBe(false);
    });
  });

  test("reads and writes the atom map as local JSON", async () => {
    await withTempStore(async (store, atomsPath) => {
      expect(JSON.stringify(store.readState())).toBe("{}");
      const nextState = store.update({ key: "prompt-history", value: ["first prompt"] });

      expect(JSON.stringify(nextState)).toBe('{"prompt-history":["first prompt"]}');
      await store.whenDurable();
      expect(readFileSync(atomsPath, "utf8")).toBe('{"prompt-history":["first prompt"]}');
    });
  });

  test("assigns ordered revisions on commit and saves the latest state", async () => {
    await withTempStore(async (store, atomsPath) => {
      const first = store.commitMutation(
        { key: " prompt-history ", value: ["first"], mutationId: "mutation-1" },
        "renderer-7",
      );
      const second = store.commitMutation(
        { key: "prompt-history", value: ["second"], mutationId: "mutation-2" },
        "renderer-9",
      );

      expect(first).toEqual({
        key: "prompt-history",
        value: ["first"],
        mutationId: "mutation-1",
        revision: 1,
        originRendererId: "renderer-7",
      });
      expect(second.revision).toBe(2);
      expect(store.readSnapshot()).toEqual({
        revision: 2,
        values: { "prompt-history": ["second"] },
      });
      await store.whenDurable(first.revision);
      expect(readFile(atomsPath)).toEqual({ "prompt-history": ["second"] });
    });
  });

  test("saves a burst of changes with one write instead of one per change", async () => {
    await withTempStore(async (store, atomsPath) => {
      let draft = "";
      for (const character of "typing a draft") {
        draft += character;
        store.commitMutation({ key: "draft", value: draft, mutationId: draft }, "renderer-1");
      }
      await store.whenDurable();
      expect(readFile(atomsPath)).toEqual({ draft: "typing a draft" });
      expect(rename).toHaveBeenCalledTimes(1);

      // A change made while a write is under way is saved by the write after it.
      const writeFile = vi.mocked(rename).getMockImplementation()!;
      vi.mocked(rename).mockImplementationOnce(async (from, to) => {
        store.update({ key: "draft", value: "after" });
        return writeFile(from, to);
      });
      store.update({ key: "draft", value: "during" });
      await store.whenDurable();
      await store.whenDurable();
      expect(readFile(atomsPath)).toEqual({ draft: "after" });
      expect(rename).toHaveBeenCalledTimes(3);
    });
  });

  test("a failed write keeps its changes and the next change saves them", async () => {
    await withTempStore(async (store, atomsPath) => {
      store.update({ key: "widget-state", value: { count: 1 } });
      await store.whenDurable();
      rmSync(atomsPath);
      mkdirSync(atomsPath);

      const events = store.removeAtoms(["widget-state"], "clear", null);
      expect(events.map((event) => event.revision)).toEqual([2]);
      await expect(store.whenDurable(2)).rejects.toThrow();
      expect(store.readSnapshot()).toEqual({ revision: 2, values: {} });

      rmSync(atomsPath, { recursive: true });
      store.update({ key: "draft", value: "kept" });
      await store.whenDurable();
      expect(readFile(atomsPath)).toEqual({ draft: "kept" });
      expect(new PersistedAtomStore(atomsPath).readState()).toEqual({ draft: "kept" });
    });
  });

  test("deletes related atom keys durably with ordered events and preserves interleaved writes", async () => {
    await withTempStore(async (store, atomsPath) => {
      store.update({ key: "widget-state", value: { count: 1 } });
      store.update({ key: "widget-interaction", value: { selected: 2 } });
      store.update({ key: "draft", value: "latest draft" });
      const events = store.removeAtoms(
        [" widget-state ", "widget-interaction", "widget-state", "missing"],
        " clear-widget ",
        "renderer-7",
      );

      expect(events).toEqual([
        {
          key: "widget-state",
          value: undefined,
          revision: 4,
          mutationId: "clear-widget",
          originRendererId: "renderer-7",
        },
        {
          key: "widget-interaction",
          value: undefined,
          revision: 5,
          mutationId: "clear-widget",
          originRendererId: "renderer-7",
        },
      ]);
      expect(store.readSnapshot()).toEqual({ revision: 5, values: { draft: "latest draft" } });
      await store.whenDurable();
      expect(readFile(atomsPath)).toEqual({ draft: "latest draft" });
      expect(new PersistedAtomStore(atomsPath).readState()).toEqual({ draft: "latest draft" });
      expect(store.removeAtoms(["widget-state", "missing"], "second-clear", null)).toEqual([]);
      expect(store.readSnapshot()).toEqual({ revision: 5, values: { draft: "latest draft" } });
      expect(
        store.commitMutation({ key: "draft", value: "next draft", mutationId: "next" }, null)
          .revision,
      ).toBe(6);
    });
  });

  test("invalid batch deletion input cannot partially delete a valid key", async () => {
    await withTempStore((store) => {
      store.update({ key: "widget-state", value: { count: 1 } });
      const before = store.readSnapshot();
      expect(() => store.removeAtoms(["widget-state", " "], "clear", null)).toThrow();
      expect(() => store.removeAtoms(["widget-state"], " ", null)).toThrow();
      expect(store.readSnapshot()).toEqual(before);
    });
  });

  test("ignores blank keys and falls back to an empty map for invalid JSON", async () => {
    await withTempStore((store, atomsPath) => {
      expect(JSON.stringify(store.update({ key: "   ", value: "ignored" }))).toBe("{}");
      writeFileSync(atomsPath, "not json", "utf8");

      expect(JSON.stringify(new PersistedAtomStore(atomsPath).readState())).toBe("{}");
    });
  });

  test("isolates cache and revision state between Main owners", async () => {
    await withTempStore(async (first, atomsPath) => {
      first.update({ key: "draft", value: "persisted" });
      expect(first.readSnapshot().revision).toBe(1);
      await first.whenDurable();

      const replacement = new PersistedAtomStore(atomsPath);
      expect(replacement.readSnapshot()).toEqual({
        revision: 0,
        values: { draft: "persisted" },
      });
    });
  });
});
