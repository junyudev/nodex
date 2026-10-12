import { describe, expect, test } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PersistedAtomStore } from "./persisted-atoms";

function withTempStore<T>(callback: (store: PersistedAtomStore, atomsPath: string) => T): T {
  const storeDir = mkdtempSync(join(tmpdir(), "nodex-persisted-atoms-"));
  const atomsPath = join(storeDir, "persisted-atoms-v1.json");

  try {
    return callback(new PersistedAtomStore(atomsPath), atomsPath);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
}

describe("persisted atom local store", () => {
  test("delivers committed updates and batch deletion once, without letting delivery fail a commit", () => {
    withTempStore((store, atomsPath) => {
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
      expect(JSON.parse(readFileSync(atomsPath, "utf8"))).toEqual({});
      stop();
      stopFailing();
      store.update({ key: "other", value: 3 });
      expect(events).toHaveLength(4);
    });
  });

  test("undefined mutation deletes a key in both the durable file and live inventory", () => {
    withTempStore((store, atomsPath) => {
      store.update({ key: "state", value: { selected: 1 } });
      store.update({ key: "state", value: undefined });
      expect(Object.hasOwn(store.readState(), "state")).toBe(false);
      expect(Object.hasOwn(JSON.parse(readFileSync(atomsPath, "utf8")), "state")).toBe(false);
    });
  });
  test("reads and writes the atom map as local JSON", () => {
    withTempStore((store, atomsPath) => {
      expect(JSON.stringify(store.readState())).toBe("{}");
      const nextState = store.update({
        key: "prompt-history",
        value: ["first prompt"],
      });

      expect(JSON.stringify(nextState)).toBe('{"prompt-history":["first prompt"]}');
      expect(existsSync(atomsPath)).toBe(true);
      expect(readFileSync(atomsPath, "utf8")).toBe(
        '{\n  "prompt-history": [\n    "first prompt"\n  ]\n}',
      );
    });
  });

  test("assigns ordered revisions only after durable mutation succeeds", () => {
    withTempStore((store, atomsPath) => {
      const first = store.commitMutation(
        {
          key: " prompt-history ",
          value: ["first"],
          mutationId: "mutation-1",
        },
        "renderer-7",
      );
      const second = store.commitMutation(
        {
          key: "prompt-history",
          value: ["second"],
          mutationId: "mutation-2",
        },
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
      expect(JSON.parse(readFileSync(atomsPath, "utf8"))).toEqual({
        "prompt-history": ["second"],
      });
    });
  });

  test("does not advance the revision when the durable write fails", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "nodex-persisted-atoms-failure-"));
    const store = new PersistedAtomStore(storeDir);
    try {
      expect(() =>
        store.commitMutation(
          {
            key: "draft",
            value: "not persisted",
            mutationId: "mutation-failed",
          },
          "renderer-1",
        ),
      ).toThrow();
      expect(store.readSnapshot()).toEqual({ revision: 0, values: {} });
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  test("deletes related atom keys durably with ordered events and preserves interleaved writes", () => {
    withTempStore((store, atomsPath) => {
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
      expect(JSON.parse(readFileSync(atomsPath, "utf8"))).toEqual({ draft: "latest draft" });
      expect(new PersistedAtomStore(atomsPath).readState()).toEqual({ draft: "latest draft" });
      expect(store.removeAtoms(["widget-state", "missing"], "second-clear", null)).toEqual([]);
      expect(store.readSnapshot()).toEqual({ revision: 5, values: { draft: "latest draft" } });
      expect(
        store.commitMutation({ key: "draft", value: "next draft", mutationId: "next" }, null)
          .revision,
      ).toBe(6);
    });
  });

  test("a failed batch delete preserves both cached values and the revision", () => {
    withTempStore((store, atomsPath) => {
      store.update({ key: "widget-state", value: { count: 1 } });
      store.update({ key: "widget-interaction", value: { selected: 2 } });
      const before = store.readSnapshot();
      rmSync(atomsPath);
      mkdirSync(atomsPath);

      expect(() =>
        store.removeAtoms(["widget-state", "widget-interaction"], "clear", null),
      ).toThrow();
      expect(store.readSnapshot()).toEqual(before);

      rmSync(atomsPath, { recursive: true });
      expect(store.removeAtoms(["widget-state", "widget-interaction"], "retry", null)).toEqual([
        {
          key: "widget-state",
          value: undefined,
          mutationId: "retry",
          revision: 3,
          originRendererId: null,
        },
        {
          key: "widget-interaction",
          value: undefined,
          mutationId: "retry",
          revision: 4,
          originRendererId: null,
        },
      ]);
      expect(JSON.parse(readFileSync(atomsPath, "utf8"))).toEqual({});
    });
  });

  test("invalid batch deletion input cannot partially delete a valid key", () => {
    withTempStore((store) => {
      store.update({ key: "widget-state", value: { count: 1 } });
      const before = store.readSnapshot();
      expect(() => store.removeAtoms(["widget-state", " "], "clear", null)).toThrow();
      expect(() => store.removeAtoms(["widget-state"], " ", null)).toThrow();
      expect(store.readSnapshot()).toEqual(before);
    });
  });

  test("ignores blank keys and falls back to an empty map for invalid JSON", () => {
    withTempStore((store, atomsPath) => {
      expect(JSON.stringify(store.update({ key: "   ", value: "ignored" }))).toBe("{}");
      writeFileSync(atomsPath, "not json", "utf8");

      expect(JSON.stringify(new PersistedAtomStore(atomsPath).readState())).toBe("{}");
    });
  });

  test("isolates cache and revision state between Main owners", () => {
    withTempStore((first, atomsPath) => {
      first.update({ key: "draft", value: "persisted" });
      expect(first.readSnapshot().revision).toBe(1);

      const replacement = new PersistedAtomStore(atomsPath);
      expect(replacement.readSnapshot()).toEqual({
        revision: 0,
        values: { draft: "persisted" },
      });
    });
  });
});
