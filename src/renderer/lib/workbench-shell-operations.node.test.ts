import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  definitions: [] as unknown[],
  invoke: vi.fn(),
}));

vi.mock("./renderer-command", async (importOriginal) => {
  const original = await importOriginal<typeof import("./renderer-command")>();
  return {
    ...original,
    defineRendererCommand: (definition: unknown) => {
      mocks.definitions.push(definition);
      return original.defineRendererCommand(definition as never);
    },
  };
});

import {
  archiveWorkbenchThread,
  moveWorkbenchSidebarThread,
  openWorkbenchWindow,
  pickProjectSourceRoots,
} from "./workbench-shell-operations";

describe("Workbench Shell renderer commands", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    vi.stubGlobal("window", { api: { invoke: mocks.invoke } });
  });

  const definitionsFor = (...channels: string[]) =>
    channels.map((channel) =>
      mocks.definitions.find(
        (definition) =>
          typeof definition === "object" &&
          definition !== null &&
          "channel" in definition &&
          definition.channel === channel,
      ),
    );

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves each Shell command's arguments and returned value contract", async () => {
    const moved = {
      status: "moved" as const,
      threadId: "thread-1",
      source: { projectId: null },
      destination: { projectId: "project-1" },
      operationId: "op-1",
      projectionRevision: 42,
    };
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === "codex:sidebar:thread:move") return moved;
      if (channel === "codex:thread:archive") return true;
      if (channel === "window:new") return true;
      if (channel === "projects:pick-source-roots") return ["/workspace/one"];
      throw new Error(`Unexpected channel: ${channel}`);
    });

    await expect(
      moveWorkbenchSidebarThread({
        hostId: "local",
        threadId: "thread-1",
        sourceContainerId: "chats",
        targetContainerId: "project:project-1",
        beforeThreadId: null,
      }),
    ).resolves.toEqual(moved);
    await expect(archiveWorkbenchThread("thread-1")).resolves.toBe(true);
    await expect(
      openWorkbenchWindow({ activeProjectId: "project-1", activeProjectSessionId: "session-1" }),
    ).resolves.toBe(true);
    await expect(pickProjectSourceRoots()).resolves.toEqual(["/workspace/one"]);

    expect(mocks.invoke.mock.calls).toEqual([
      [
        "codex:sidebar:thread:move",
        {
          hostId: "local",
          threadId: "thread-1",
          sourceContainerId: "chats",
          targetContainerId: "project:project-1",
          beforeThreadId: null,
        },
      ],
      ["codex:thread:archive", "thread-1"],
      ["window:new", { activeProjectId: "project-1", activeProjectSessionId: "session-1" }],
      ["projects:pick-source-roots"],
    ]);
    expect(
      definitionsFor(
        "codex:sidebar:thread:move",
        "codex:thread:archive",
        "window:new",
        "projects:pick-source-roots",
      ),
    ).toMatchObject([
      {
        channel: "codex:sidebar:thread:move",
        authority: "main",
        owner: "WorkbenchSidebarController",
        protocol: { kind: "returned_value" },
      },
      {
        channel: "codex:thread:archive",
        authority: "external",
        owner: "WorkbenchSidebarController",
        protocol: { kind: "returned_value" },
      },
      {
        channel: "window:new",
        authority: "main",
        owner: "WorkbenchShell",
        protocol: { kind: "returned_value" },
      },
      {
        channel: "projects:pick-source-roots",
        authority: "external",
        owner: "ProjectSourcesEditor",
        protocol: { kind: "returned_value" },
      },
    ]);
  });
});
