import { describe, expect, test } from "vite-plus/test";
import {
  WorkspaceDirectoryEntriesInputSchema,
  WorkspaceFileBinaryReadInputSchema,
  WorkspaceFileMetadataInputSchema,
  WorkspaceFileRequestSchema,
  WorkspaceFileTextReadInputSchema,
  WorkspaceFileWriteInputSchema,
  WorkspaceLocalFileRequestSchema,
  WorkspacePathsExistInputSchema,
} from "./workspace-files";
import { WORKSPACE_FILE_BINARY_MAX_BYTES, WORKSPACE_FILE_PREVIEW_MAX_BYTES } from "../types";

describe("workspace file IPC schemas", () => {
  test("bounds base64 reads independently of the preview size ceiling", () => {
    const path = "/workspace/movie.webm";
    expect(WorkspaceFileBinaryReadInputSchema.parse({ path })).toEqual({ path });
    expect(
      WorkspaceFileBinaryReadInputSchema.parse({ path, maxBytes: WORKSPACE_FILE_BINARY_MAX_BYTES }),
    ).toEqual({ path, maxBytes: WORKSPACE_FILE_BINARY_MAX_BYTES });
    for (const maxBytes of [0, -1, 1.5, WORKSPACE_FILE_BINARY_MAX_BYTES + 1])
      expect(() => WorkspaceFileBinaryReadInputSchema.parse({ path, maxBytes })).toThrow();
    expect(
      WorkspaceFileMetadataInputSchema.parse({
        path,
        contentSampleMaxFileBytes: WORKSPACE_FILE_PREVIEW_MAX_BYTES,
      }),
    ).toEqual({ path, contentSampleMaxFileBytes: WORKSPACE_FILE_PREVIEW_MAX_BYTES });
  });
  test("admits host-qualified reads while keeping writes and local watches local", () => {
    const input = { hostId: "ssh:build", path: "/workspace/report.md " };
    expect(WorkspaceFileMetadataInputSchema.parse(input)).toEqual(input);
    expect(WorkspaceFileTextReadInputSchema.parse({ ...input, maxBytes: 1024 })).toEqual({
      ...input,
      maxBytes: 1024,
    });
    expect(() => WorkspaceLocalFileRequestSchema.parse(input)).toThrow();
    expect(() =>
      WorkspaceFileWriteInputSchema.parse({
        ...input,
        content: "changed",
        expectedMtimeMs: null,
      }),
    ).toThrow();
    const paths = { hostId: "ssh:build", paths: ["/workspace/report.md", "/workspace/trailing "] };
    expect(WorkspacePathsExistInputSchema.parse(paths)).toEqual(paths);
    const directory = {
      hostId: "ssh:build",
      workspaceRoot: "/workspace/trailing ",
      directoryPath: "src ",
      directoriesOnly: true,
    };
    expect(WorkspaceDirectoryEntriesInputSchema.parse(directory)).toEqual(directory);
  });
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
