import { describe, expect, test } from "vite-plus/test";
import {
  decideWorkspaceFileTabOpen,
  type WorkspaceFileTabCandidate,
} from "./workspace-file-tab-model";

const empty: WorkspaceFileTabCandidate = {
  hostId: "local",
  id: "files-empty",
  path: null,
};
const durable: WorkspaceFileTabCandidate = {
  hostId: "local",
  id: "files-a",
  path: "/repo/a.ts",
};
const preview: WorkspaceFileTabCandidate = {
  hostId: "local",
  id: "preview-b",
  path: "/repo/b.ts",
};

describe("workspace file tab state machine", () => {
  test("separates the same path on different hosts and pins only its own preview", () => {
    const remote = { ...preview, hostId: "remote-ssh-discovered:win" };
    expect(
      decideWorkspaceFileTabOpen({
        activeDurableTabId: durable.id,
        durableTabs: [durable],
        hostId: remote.hostId,
        mode: "preview",
        path: durable.path!,
        previewTab: null,
      }),
    ).toEqual({ kind: "create-preview", replacingPreviewTabId: null });
    expect(
      decideWorkspaceFileTabOpen({
        activeDurableTabId: durable.id,
        durableTabs: [durable],
        hostId: remote.hostId,
        mode: "durable",
        path: remote.path!,
        previewTab: remote,
      }),
    ).toEqual({ kind: "pin-preview", tabId: remote.id });
    expect(
      decideWorkspaceFileTabOpen({
        activeDurableTabId: durable.id,
        durableTabs: [durable],
        hostId: "local",
        mode: "preview",
        path: remote.path!,
        previewTab: remote,
      }),
    ).toEqual({ kind: "create-preview", replacingPreviewTabId: remote.id });
  });
  test("creates a semantic file tab before closing the active empty tab", () => {
    expect(
      decideWorkspaceFileTabOpen({
        activeDurableTabId: empty.id,
        durableTabs: [empty],
        hostId: "local",
        mode: "preview",
        path: "/repo/a.ts",
        previewTab: null,
      }),
    ).toEqual({ kind: "create-from-empty", emptyTabId: empty.id });
  });

  test("creates, replaces, and pins the leaf preview explicitly", () => {
    expect(
      decideWorkspaceFileTabOpen({
        activeDurableTabId: durable.id,
        durableTabs: [durable],
        hostId: "local",
        mode: "preview",
        path: "/repo/b.ts",
        previewTab: null,
      }),
    ).toEqual({ kind: "create-preview", replacingPreviewTabId: null });
    expect(
      decideWorkspaceFileTabOpen({
        activeDurableTabId: durable.id,
        durableTabs: [durable],
        hostId: "local",
        mode: "preview",
        path: "/repo/c.ts",
        previewTab: preview,
      }),
    ).toEqual({
      kind: "create-preview",
      replacingPreviewTabId: preview.id,
    });
    expect(
      decideWorkspaceFileTabOpen({
        activeDurableTabId: durable.id,
        durableTabs: [durable],
        hostId: "local",
        mode: "durable",
        path: preview.path ?? "",
        previewTab: preview,
      }),
    ).toEqual({ kind: "pin-preview", tabId: preview.id });
  });

  test("reuses matching durable and preview tabs without duplication", () => {
    expect(
      decideWorkspaceFileTabOpen({
        activeDurableTabId: durable.id,
        durableTabs: [durable],
        hostId: "local",
        mode: "preview",
        path: durable.path ?? "",
        previewTab: preview,
      }),
    ).toEqual({ kind: "focus-durable", tabId: durable.id });
    expect(
      decideWorkspaceFileTabOpen({
        activeDurableTabId: durable.id,
        durableTabs: [durable],
        hostId: "local",
        mode: "preview",
        path: preview.path ?? "",
        previewTab: preview,
      }),
    ).toEqual({ kind: "focus-preview", tabId: preview.id });
  });

  test("keeps an unrelated preview when focusing an existing durable file", () => {
    expect(
      decideWorkspaceFileTabOpen({
        activeDurableTabId: preview.id,
        durableTabs: [durable],
        hostId: "local",
        mode: "preview",
        path: durable.path ?? "",
        previewTab: preview,
      }),
    ).toEqual({ kind: "focus-durable", tabId: durable.id });
  });

  test("does not classify an unrelated preview as replaced for a direct durable open", () => {
    expect(
      decideWorkspaceFileTabOpen({
        activeDurableTabId: durable.id,
        durableTabs: [durable],
        hostId: "local",
        mode: "durable",
        path: "/repo/c.ts",
        previewTab: preview,
      }),
    ).toEqual({ kind: "create-durable" });
  });
});
