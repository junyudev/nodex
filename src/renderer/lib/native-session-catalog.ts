import type {
  NativeConversationImportInput,
  NativeConversationImportPreviewInput,
  NativeSessionCatalogInput,
} from "../../shared/native-session-catalog";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const importNativeConversationCommand = defineRendererCommand({
  key: "native_session.import",
  channel: "native-sessions:import",
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

export const previewNativeConversationImport = (input: NativeConversationImportPreviewInput) =>
  invokeRendererQuery("native-sessions:preview-import", input);

export const importNativeConversation = (input: NativeConversationImportInput) =>
  invokePlainCommand(importNativeConversationCommand, input);

/** The native folder dialog is the only source of a replacement working directory. */
export const pickNativeConversationImportDirectory = () =>
  invokePlainCommand(pickImportDirectoryCommand, { title: "Choose working directory" });

export const readNativeSessionProjects = (after: string | null = null) =>
  invokeRendererQuery("projects:list", { after, first: 100 });
