import type {
  CodexComposerAppshotCaptureInput,
  CodexComposerAppshotContext,
} from "../../../shared/types";
import type { ComposerPickedFile } from "../../../shared/ipc-api";
import type { CodexPermissionState, WorkspaceFileSearchInput } from "@/lib/types";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererQuery,
} from "@/lib/renderer-command";

const activateComposerPluginCommand = defineRendererCommand({
  key: "composer_context.activate_plugin",
  channel: "codex:composer-plugins:activate",
  authority: "external",
  owner: "ComposerContextOperations",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "application" },
});

const pickComposerFilesCommand = defineRendererCommand({
  key: "composer.pick_files",
  channel: "composer:pick-files",
  authority: "external",
  owner: "ComposerContextOperations",
  protocol: { kind: "pending_operation" },
});

const captureComposerAppshotCommand = defineRendererCommand({
  key: "composer.capture_appshot",
  channel: "codex:composer-appshot:capture",
  authority: "external",
  owner: "ComposerContextOperations",
  protocol: { kind: "pending_operation" },
});

export const pickComposerFiles = async (input: {
  readonly imagesOnly: boolean;
  readonly title: string;
}): Promise<ComposerPickedFile[]> => await invokePlainCommand(pickComposerFilesCommand, input);

export const captureComposerAppshot = async (
  input: CodexComposerAppshotCaptureInput,
): Promise<CodexComposerAppshotContext> =>
  await invokePlainCommand(captureComposerAppshotCommand, input);

export const readComposerPermissionState = async (
  projectId: string | null,
): Promise<CodexPermissionState> =>
  await invokeRendererQuery("codex:permission:state:get", projectId);

/** Owns the typed transport used to discover and activate composer context sources. */
export const composerContextOperations = {
  readAppshotTarget: async () => await invokeRendererQuery("codex:composer-appshot:target"),

  searchWorkspaceFiles: async (input: WorkspaceFileSearchInput) =>
    await invokeRendererQuery("workspace-file-search", input),

  searchChatGptConversations: async (query: string) =>
    await invokeRendererQuery("codex:composer-chatgpt-conversations:list", { query }),

  activatePlugin: async (id: string, cwds: readonly string[]) =>
    await invokePlainCommand(activateComposerPluginCommand, { id, cwds: [...cwds] }),

  pickFiles: pickComposerFiles,

  captureAppshot: captureComposerAppshot,

  readPermissionState: readComposerPermissionState,
};
