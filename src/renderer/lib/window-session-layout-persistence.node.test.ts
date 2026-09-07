import { describe, expect, test, vi } from "vite-plus/test";
import { createDefaultWorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import type {
  WindowSessionBootstrap,
  WindowSessionSaveLayoutInput,
} from "../../shared/window-session";
import {
  createWindowSessionLayoutPersistence,
  WorkbenchLayoutCommitRejected,
} from "./window-session-layout-persistence";

function accept(input: WindowSessionSaveLayoutInput): WindowSessionBootstrap {
  return {
    session: {
      id: input.sessionId,
      lifecycle: { state: "open" },
      layoutRevision: input.revision,
      layout: input.layout,
      createdAt: "2026-09-08T00:00:00Z",
      updatedAt: "2026-09-08T00:00:00Z",
      focusedAt: "2026-09-08T00:00:00Z",
    },
  };
}

describe("Window Session layout commits", () => {
  test("serializes exact command snapshots and retains each requested presentation revision", async () => {
    const initialLayout = createDefaultWorkbenchLayoutSnapshot();
    let finishFirstSave!: (result: WindowSessionBootstrap) => void;
    const firstSave = new Promise<WindowSessionBootstrap>((resolve) => {
      finishFirstSave = resolve;
    });
    const save = vi
      .fn<(input: WindowSessionSaveLayoutInput) => Promise<WindowSessionBootstrap>>()
      .mockImplementationOnce(() => firstSave)
      .mockImplementation(async (input) => accept(input));
    const writer = createWindowSessionLayoutPersistence({
      sessionId: "window-a",
      initialRevision: 4,
      initialLayout,
      save,
    });
    const pages = { ...initialLayout, location: { kind: "pages" as const } };
    const project = {
      ...initialLayout,
      location: { kind: "project" as const, projectId: "project-b" },
    };

    const first = writer.commit({ layout: pages, presentationRevision: 11 });
    const second = writer.commit({ layout: project, presentationRevision: 12 });
    const duplicate = writer.commit({ layout: project, presentationRevision: 13 });
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({ revision: 5, layout: pages });
    finishFirstSave(accept(save.mock.calls[0]![0]));

    await expect(first).resolves.toEqual({
      sessionId: "window-a",
      layoutRevision: 5,
      presentationRevision: 11,
      layout: pages,
    });
    await expect(second).resolves.toEqual({
      sessionId: "window-a",
      layoutRevision: 6,
      presentationRevision: 12,
      layout: project,
    });
    await expect(duplicate).resolves.toEqual({
      sessionId: "window-a",
      layoutRevision: 6,
      presentationRevision: 13,
      layout: project,
    });
    expect(save).toHaveBeenCalledTimes(2);
  });

  test("rejects an ignored layout save and repairs through the same revision sequence", async () => {
    const initialLayout = createDefaultWorkbenchLayoutSnapshot();
    const save = vi
      .fn<(input: WindowSessionSaveLayoutInput) => Promise<WindowSessionBootstrap>>()
      .mockImplementationOnce(async (input) =>
        accept({ ...input, revision: 9, layout: initialLayout }),
      )
      .mockImplementation(async (input) => accept(input));
    const writer = createWindowSessionLayoutPersistence({
      sessionId: "window-a",
      initialRevision: 4,
      initialLayout,
      save,
    });
    const desired = {
      layout: { ...initialLayout, location: { kind: "pages" as const } },
      presentationRevision: 3,
    };

    await expect(writer.commit(desired)).rejects.toBeInstanceOf(WorkbenchLayoutCommitRejected);
    await expect(writer.commit(desired)).resolves.toMatchObject({
      layoutRevision: 10,
      presentationRevision: 3,
      layout: desired.layout,
    });
    expect(save.mock.calls[1]?.[0].revision).toBe(10);
  });

  test("does not accept another window's receipt or write ephemeral-only changes", async () => {
    const initialLayout = createDefaultWorkbenchLayoutSnapshot();
    const save = vi.fn(async (input: WindowSessionSaveLayoutInput) =>
      accept({ ...input, sessionId: "window-b" }),
    );
    const writer = createWindowSessionLayoutPersistence({
      sessionId: "window-a",
      initialRevision: 4,
      initialLayout,
      save,
    });
    await expect(
      writer.commit({ layout: initialLayout, presentationRevision: 8 }),
    ).resolves.toMatchObject({ sessionId: "window-a", layoutRevision: 4, presentationRevision: 8 });
    expect(save).not.toHaveBeenCalled();
    await expect(
      writer.commit({
        layout: { ...initialLayout, location: { kind: "pages" } },
        presentationRevision: 9,
      }),
    ).rejects.toBeInstanceOf(WorkbenchLayoutCommitRejected);
  });
});
