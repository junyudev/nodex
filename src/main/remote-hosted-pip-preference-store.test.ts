import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { makeRemoteHostedPipPreferences } from "./remote-hosted-pip-preference-store";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("RemoteHostedPipPreferencesAdapter", () => {
  test("persists a native resize and fails closed on invalid data", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-pip-preference-"));
    temporaryRoots.push(root);
    const filePath = path.join(root, "remote-hosted-pip.json");
    const store = makeRemoteHostedPipPreferences(filePath);

    expect(store.readAlwaysHide()).toBe(false);
    expect(store.readMaxDisplaySize()).toBeNull();
    store.writeMaxDisplaySize(312.5);
    store.writeAlwaysHide(true);
    const reloaded = makeRemoteHostedPipPreferences(filePath);
    expect(reloaded.readMaxDisplaySize()).toBe(312.5);
    expect(reloaded.readAlwaysHide()).toBe(true);

    fs.writeFileSync(filePath, JSON.stringify({ alwaysHide: "yes", maxDisplaySize: -1 }));
    expect(store.readAlwaysHide()).toBe(false);
    expect(store.readMaxDisplaySize()).toBeNull();
    expect(fs.readdirSync(root).some((entry) => entry.includes(".corrupt-"))).toBe(true);
  });

  test("persists bounded per-task visibility with monotonic revisions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-pip-preference-"));
    temporaryRoots.push(root);
    const filePath = path.join(root, "remote-hosted-pip.json");
    const store = makeRemoteHostedPipPreferences(filePath);

    expect(store.setTaskVisibility("thread-1", "hidden")).toBe(true);
    const hidden = store.readSnapshot();
    expect(hidden.taskVisibilities).toEqual({ "thread-1": "hidden" });
    expect(store.setTaskVisibility("thread-1", "hidden")).toBe(false);
    expect(store.readSnapshot().revision).toBe(hidden.revision);
    expect(store.deleteTaskVisibility("thread-1")).toBe(true);

    const reloaded = makeRemoteHostedPipPreferences(filePath).readSnapshot();
    expect(reloaded.taskVisibilities).toEqual({});
    expect(reloaded.revision).toBeGreaterThan(hidden.revision);
  });

  test("commits one native visibility batch with one durable revision", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-pip-preference-"));
    temporaryRoots.push(root);
    const filePath = path.join(root, "remote-hosted-pip.json");
    const store = makeRemoteHostedPipPreferences(filePath);

    expect(store.setTaskVisibilities(["thread-a", "thread-b", "thread-a"], "hidden")).toBe(true);
    expect(store.readSnapshot()).toMatchObject({
      revision: 1,
      taskVisibilities: { "thread-a": "hidden", "thread-b": "hidden" },
    });
    expect(store.setTaskVisibilities(["thread-a", "thread-b"], "hidden")).toBe(false);
    expect(store.readSnapshot().revision).toBe(1);
    expect(store.setTaskVisibilities(["thread-c", ""], "shown")).toBe(false);
    expect(store.readSnapshot()).toMatchObject({
      revision: 1,
      taskVisibilities: { "thread-a": "hidden", "thread-b": "hidden" },
    });
  });
});
