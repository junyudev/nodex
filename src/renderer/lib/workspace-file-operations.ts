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
  WorkspacePathsExistInput,
  WorkspacePathsExistResult,
} from "../../shared/types";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "./renderer-command";

export async function readWorkspacePathsExist(
  input: WorkspacePathsExistInput,
): Promise<WorkspacePathsExistResult> {
  return await invokeRendererQuery("workspace-paths-exist", input);
}

const writeWorkspaceFileCommand = defineRendererCommand({
  key: "workspace_file.write",
  channel: "write-file",
  authority: "external",
  owner: "WorkspaceFiles",
  protocol: { kind: "returned_value" },
});
const saveWorkspaceFileCopyCommand = defineRendererCommand({
  key: "workspace_file.save_copy",
  channel: "workspace-file:save-copy",
  authority: "external",
  owner: "WorkspaceFiles",
  protocol: { kind: "returned_value" },
});

const saveWorkspaceFileDataCommand = defineRendererCommand({
  key: "workspace_file.save_data",
  channel: "workspace-file:save-data",
  authority: "external",
  owner: "WorkspaceFiles",
  protocol: { kind: "returned_value" },
});

export async function saveWorkspaceFileData(input: {
  readonly fileName: string;
  readonly contentsBase64: string;
}): Promise<{ path: string | null }> {
  return await invokePlainCommand(saveWorkspaceFileDataCommand, input);
}

export async function readWorkspaceFileGitHubUrl(
  input: WorkspaceFileRequest & { readonly line?: number },
): Promise<string | null> {
  return await invokeRendererQuery("workspace-file:github-url", input);
}

export async function saveWorkspaceFileCopy(
  input: WorkspaceFileRequest,
): Promise<{ path: string | null }> {
  return await invokePlainCommand(saveWorkspaceFileCopyCommand, input);
}

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
