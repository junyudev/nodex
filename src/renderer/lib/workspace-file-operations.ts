import type {
  WorkspaceFileMetadata,
  WorkspaceFileMetadataInput,
  WorkspaceFileReadResult,
  WorkspaceFileRequest,
  WorkspaceFileTextReadInput,
  WorkspaceFileWatchStartResult,
  WorkspaceFileWatchStopInput,
  WorkspaceFileWriteInput,
  WorkspaceFileWriteResult,
} from "../../shared/types";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "./renderer-command";

const writeWorkspaceFileCommand = defineRendererCommand({
  key: "workspace_file.write",
  channel: "write-file",
  authority: "external",
  owner: "WorkspaceFiles",
  protocol: { kind: "returned_value" },
});

export async function readWorkspaceFileMetadata(
  input: WorkspaceFileMetadataInput,
): Promise<WorkspaceFileMetadata> {
  return await invokeRendererQuery("read-file-metadata", input);
}

export async function readWorkspaceFileText(
  input: WorkspaceFileTextReadInput,
): Promise<WorkspaceFileReadResult> {
  return await invokeRendererQuery("read-file", input);
}

export async function writeWorkspaceFile(
  input: WorkspaceFileWriteInput,
): Promise<WorkspaceFileWriteResult> {
  return await invokePlainCommand(writeWorkspaceFileCommand, input);
}

export async function startWorkspaceFileWatch(
  input: WorkspaceFileRequest,
): Promise<WorkspaceFileWatchStartResult> {
  return await invokeRendererControl("workspace-file-watch:start", input);
}

export async function stopWorkspaceFileWatch(input: WorkspaceFileWatchStopInput): Promise<void> {
  await invokeRendererControl("workspace-file-watch:stop", input);
}
