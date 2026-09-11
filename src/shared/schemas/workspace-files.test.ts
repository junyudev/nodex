import { describe, expect, test } from "vite-plus/test";
import {
  WorkspaceDirectoryEntriesInputSchema,
  WorkspaceFileMetadataInputSchema,
  WorkspaceFileRequestSchema,
  WorkspaceFileTextReadInputSchema,
  WorkspaceFileWriteInputSchema,
} from "./workspace-files";

describe("workspace file IPC schemas", () => {
  test("keeps workspace roots only on directory browsing", () => {
    expect(
      WorkspaceDirectoryEntriesInputSchema.parse({
        workspaceRoot: "/project",
        directoryPath: "src",
      }),
    ).toEqual({
      workspaceRoot: "/project",
      directoryPath: "src",
    });
    expect(() =>
      WorkspaceFileRequestSchema.parse({
        workspaceRoot: "/project",
        path: "/worktree/file.ts",
      }),
    ).toThrow();
    expect(() =>
      WorkspaceFileMetadataInputSchema.parse({
        workspaceRoot: "/project",
        path: "/worktree/file.ts",
        contentSampleByteLimit: 8_192,
      }),
    ).toThrow();
    expect(() =>
      WorkspaceFileWriteInputSchema.parse({
        workspaceRoot: "/project",
        path: "/worktree/file.ts",
        content: "next",
        expectedMtimeMs: null,
      }),
    ).toThrow();
  });

  test("validates metadata sampling limits", () => {
    expect(
      WorkspaceFileMetadataInputSchema.parse({
        path: "/worktree/file.ts",
        contentSampleByteLimit: 8_192,
        contentSampleMaxFileBytes: 1_500_000,
      }),
    ).toEqual({
      path: "/worktree/file.ts",
      contentSampleByteLimit: 8_192,
      contentSampleMaxFileBytes: 1_500_000,
    });
    expect(() =>
      WorkspaceFileMetadataInputSchema.parse({
        path: "/worktree/file.ts",
        contentSampleByteLimit: 0,
      }),
    ).toThrow();
  });

  test("requires a bounded text-read limit", () => {
    expect(
      WorkspaceFileTextReadInputSchema.parse({
        path: "/worktree/file.ts",
        maxBytes: 1_500_000,
      }),
    ).toEqual({
      path: "/worktree/file.ts",
      maxBytes: 1_500_000,
    });
    expect(() =>
      WorkspaceFileTextReadInputSchema.parse({
        path: "/worktree/file.ts",
      }),
    ).toThrow();
  });

  test("requires compare-and-swap state for writes", () => {
    expect(
      WorkspaceFileWriteInputSchema.parse({
        path: "/worktree/file.ts",
        content: "next",
        expectedMtimeMs: null,
      }),
    ).toEqual({
      path: "/worktree/file.ts",
      content: "next",
      expectedMtimeMs: null,
    });
    expect(() =>
      WorkspaceFileWriteInputSchema.parse({
        path: "/worktree/file.ts",
        content: "next",
      }),
    ).toThrow();
  });
});
