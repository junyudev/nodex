import type {
  CodexThreadImportInput,
  CodexThreadImportPreviewInput,
  NativeSessionAttachInput,
  NativeSessionCatalogInput,
} from "../../shared/native-session-catalog";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const attachNativeSessionCommand = defineRendererCommand({
  key: "native_session.attach",
  channel: "native-sessions:attach",
  authority: "main",
  owner: "NativeSessionCatalog",
  protocol: { kind: "returned_value" },
});

const importCodexThreadCommand = defineRendererCommand({
  key: "native_session.import_codex",
  channel: "native-sessions:import-codex",
  authority: "main",
  owner: "NativeSessionCatalog",
  protocol: { kind: "returned_value" },
});

const pickImportDirectoryCommand = defineRendererCommand({
  key: "native_session.pick_import_directory",
  channel: "workspace:pick-directory",
  authority: "external",
  owner: "NativeSessionCatalog",
  protocol: { kind: "returned_value" },
});

export const listNativeSessions = (input: NativeSessionCatalogInput) =>
  invokeRendererQuery("native-sessions:list", input);

export const attachNativeSession = (input: NativeSessionAttachInput) =>
  invokePlainCommand(attachNativeSessionCommand, input);

export const previewCodexThreadImport = (input: CodexThreadImportPreviewInput) =>
  invokeRendererQuery("native-sessions:preview-codex-import", input);

export const importCodexThread = (input: CodexThreadImportInput) =>
  invokePlainCommand(importCodexThreadCommand, input);

/** The native folder dialog is the only source of a replacement working directory. */
export const pickCodexThreadImportDirectory = () =>
  invokePlainCommand(pickImportDirectoryCommand, { title: "Choose working directory" });

export const readNativeSessionProjects = (after: string | null = null) =>
  invokeRendererQuery("projects:list", { after, first: 100 });

export type CodexThreadImportSelection = Omit<CodexThreadImportInput, "requestId" | "acceptedAt">;

/** Accepts an import action. Retrying identical parameters keeps the accepted request identity. */
export function acceptCodexThreadImport(
  previous: CodexThreadImportInput | null,
  selection: CodexThreadImportSelection,
): CodexThreadImportInput {
  if (
    previous &&
    previous.nativeSessionId === selection.nativeSessionId &&
    previous.expectedHome === selection.expectedHome &&
    previous.projectId === selection.projectId &&
    previous.cwd === selection.cwd
  )
    return previous;
  return { ...selection, requestId: crypto.randomUUID(), acceptedAt: Date.now() };
}
