import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  WorkbenchSceneSnapshot,
  WorkbenchSurfaceDescriptor,
} from "../../shared/workbench-scene";
import { makeWorkbenchPanelLayout } from "../../shared/workbench-panel-layout";
import { invokePlainCommand } from "./renderer-command";
import {
  recordFeatureUsed,
  recordPresentedSurfaces,
  recordProductEvent,
  resetReportedFeaturesForTests,
} from "./product-analytics";

vi.mock("./renderer-command", () => ({
  defineRendererCommand: (definition: unknown) => definition,
  invokePlainCommand: vi.fn(async () => undefined),
  invokeRendererQuery: vi.fn(),
}));

const reported = () =>
  vi.mocked(invokePlainCommand).mock.calls.map(([, event]) => event as { properties: unknown });

beforeEach(() => {
  vi.mocked(invokePlainCommand)
    .mockReset()
    .mockResolvedValue(undefined as never);
  resetReportedFeaturesForTests();
});

describe("renderer product analytics", () => {
  test("a surface reports once per window session", () => {
    recordFeatureUsed("terminal");
    recordFeatureUsed("terminal");
    recordFeatureUsed("inbox");
    expect(reported().map((event) => event.properties)).toEqual([
      { feature: "terminal" },
      { feature: "inbox" },
    ]);
  });

  test("reports the surface a person is looking at, not tabs open behind it", () => {
    const surface = (id: string, kind: string) => ({ id, kind }) as WorkbenchSurfaceDescriptor;
    const panel = (activeTabId: string, collapsed = false) => ({
      collapsed,
      layout: makeWorkbenchPanelLayout([activeTabId], activeTabId),
    });
    recordPresentedSurfaces({
      primary: surface("home", "inbox"),
      panelSurfacesById: {
        welcome: surface("welcome", "page_stage"),
        shell: surface("shell", "terminal"),
        files: surface("files", "files"),
      },
      panels: { bottom: panel("shell", true), left: panel("files"), right: panel("welcome") },
    } as unknown as WorkbenchSceneSnapshot);
    expect(reported().map((event) => event.properties)).toEqual([{ feature: "page" }]);
    expect(() => recordPresentedSurfaces(null)).not.toThrow();
  });

  test("a failed hand-off never reaches the caller", async () => {
    vi.mocked(invokePlainCommand).mockRejectedValue(new Error("no bridge"));
    expect(() => recordFeatureUsed("browser")).not.toThrow();
    vi.mocked(invokePlainCommand).mockImplementation(() => {
      throw new Error("no window");
    });
    expect(() =>
      recordProductEvent({
        name: "thread_message_navigation",
        properties: { ordinal: 1, item_count: 2 },
      }),
    ).not.toThrow();
    await Promise.resolve();
  });
});
