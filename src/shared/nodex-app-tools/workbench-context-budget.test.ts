import { describe, expect, test } from "vite-plus/test";
import {
  boundWorkbenchObservation,
  boundWorkbenchSubmission,
  WORKBENCH_CONTEXT_MAX_BYTES,
} from "./workbench-context-budget";
import {
  WorkbenchRendererObservationSchema,
  WorkbenchSubmitPresentationSchema,
  projectWorkbenchSurfaceReference,
  sameWorkbenchObservedTarget,
  type WorkbenchObservedTab,
  type WorkbenchRendererObservation,
} from "./workbench";
import { WorkbenchSurfaceDescriptorSchema } from "../schemas/workbench-scene";

const tab = (id: string, path = `/workspace/${id}`): WorkbenchObservedTab => ({
  tabId: id,
  panelId: "right",
  groupId: "right-group",
  protected: false,
  persisted: true,
  preview: false,
  selected: false,
  visible: false,
  auxiliary: null,
  surface: {
    id,
    kind: "files",
    titleSnapshot: id,
    config: {
      hostId: "local",
      projectId: "project",
      cwd: "/workspace",
      workspaceRoot: "/workspace",
      path,
    },
  },
});
const observation = (tabs: WorkbenchObservedTab[]): WorkbenchRendererObservation => ({
  sceneOwner: { kind: "session", sessionId: "session" },
  selectedSceneOwner: { kind: "session", sessionId: "session" },
  presentationRevision: 1,
  mounted: true,
  focusedTarget: { tabId: tabs.at(-1)!.tabId, panelId: "right", groupId: "right-group" },
  tabs,
  groups: [
    {
      groupId: "right-group",
      panelId: "right",
      tabIds: tabs.map((item) => item.tabId),
      selectedTabId: tabs.at(-1)!.tabId,
      focused: true,
      visible: true,
    },
    {
      groupId: "bottom-group",
      panelId: "bottom",
      tabIds: [],
      selectedTabId: null,
      focused: false,
      visible: false,
    },
  ],
  panels: [
    {
      panelId: "right",
      activeGroupId: "right-group",
      maximizedGroupId: null,
      collapsed: false,
      size: {},
    },
    {
      panelId: "bottom",
      activeGroupId: "bottom-group",
      maximizedGroupId: null,
      collapsed: true,
      size: {},
    },
  ],
  splits: [],
});

describe("bounded semantic Workbench context", () => {
  test("keeps the focused resource and closes every group reference when byte capacity is reached", () => {
    const tabs = Array.from({ length: 300 }, (_, index) =>
      tab(`tab-${index}`, `/workspace/${"目录/".repeat(900)}${index}.ts`),
    );
    const original = observation(tabs);
    const bounded = boundWorkbenchObservation(original)!;
    expect(bounded.availability).toBe("partial");
    expect(bounded.omittedTabCount).toBe(tabs.length - bounded.tabs.length);
    expect(bounded.tabs.some((item) => item.tabId === original.focusedTarget!.tabId)).toBe(true);
    const retained = new Set(bounded.tabs.map((item) => item.tabId));
    expect(
      bounded.groups.every(
        (group) =>
          group.tabIds.every((id) => retained.has(id)) &&
          (!group.selectedTabId || retained.has(group.selectedTabId)),
      ),
    ).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThan(
      WORKBENCH_CONTEXT_MAX_BYTES,
    );
    expect(WorkbenchRendererObservationSchema.safeParse(bounded).success).toBe(true);
    expect(original.tabs).toHaveLength(300);
  });

  test("omits every ambiguous occurrence instead of minting a handle for an arbitrary one", () => {
    const bounded = boundWorkbenchObservation(
      observation([tab("same", "/one"), tab("same", "/two"), tab("unique")]),
    )!;
    expect(bounded.tabs.map((item) => item.tabId)).toEqual(["unique"]);
    expect(bounded.omittedTabCount).toBe(2);
  });

  test("drops invalid optional metadata without losing another selected target", () => {
    const invalid = {
      ...tab("bad"),
      surface: { ...tab("bad").surface!, titleSnapshot: "x".repeat(2_001) },
    } as WorkbenchObservedTab;
    const bounded = boundWorkbenchSubmission({
      rendererGeneration: "generation",
      sceneOwner: { kind: "pages" },
      presentationRevision: 1,
      focusedTarget: null,
      selectedTabs: [invalid, tab("valid")],
    });
    expect(bounded.availability).toBe("partial");
    expect(bounded.selectedTabs.map((item) => item.tabId)).toEqual(["valid"]);
    expect(WorkbenchSubmitPresentationSchema.safeParse(bounded).success).toBe(true);
  });

  test("does not copy a valid image collection into the semantic snapshot", () => {
    const descriptor = WorkbenchSurfaceDescriptorSchema.parse({
      id: "images",
      kind: "image_editor",
      titleSnapshot: "Images",
      stateKey: 0,
      state: null,
      config: {
        availableImageCount: 1_000,
        composerTarget: null,
        entrypoint: "image_click",
        imageSource: "uploaded",
        images: Array.from({ length: 1_000 }, (_, index) => ({
          id: `image-${index}`,
          alt: "Image",
          source: "uploaded",
          locator: { kind: "remote", url: `https://example.test/${index}.png` },
        })),
        initialImageId: "image-0",
        initialPlaygroundTool: "navigate",
        initialView: "single",
        projectId: null,
        threadId: null,
        tooltip: "Image",
      },
    });
    expect(projectWorkbenchSurfaceReference(descriptor)).toEqual({
      id: "images",
      kind: "image_editor",
      titleSnapshot: "Images",
      config: { projectId: null, threadId: null, initialImageId: "image-0" },
    });
  });

  test("ignores title changes while fencing a replaced resource and authorization scope", () => {
    const original = tab("file");
    expect(
      sameWorkbenchObservedTarget(original, {
        ...original,
        surface: { ...original.surface!, titleSnapshot: "Renamed tab" },
      }),
    ).toBe(true);
    expect(sameWorkbenchObservedTarget(original, tab("file", "/different/file"))).toBe(false);
    const browser: WorkbenchObservedTab = {
      ...original,
      surface: {
        id: "file",
        kind: "browser",
        titleSnapshot: "Browser",
        config: { browserTabId: "runtime-a" },
      },
    };
    expect(
      sameWorkbenchObservedTarget(browser, {
        ...browser,
        surface: {
          id: "file",
          kind: "browser",
          titleSnapshot: "Same name",
          config: { browserTabId: "runtime-b" },
        },
      }),
    ).toBe(false);
  });
});
