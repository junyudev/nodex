import type { FolderPlacement } from "../../shared/folder-placement";
import { getIntl } from "@/lib/i18n";
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

const ensureFolderProjectCommand = defineRendererCommand({
  key: "native_session.ensure_folder_project",
  channel: "projects:ensure-folder",
  authority: "main",
  owner: "FolderPlacement",
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

export const discoverNativeProjects = () =>
  invokeRendererQuery("native-sessions:discover-projects");

export const previewNativeConversationImport = (input: NativeConversationImportPreviewInput) =>
  invokeRendererQuery("native-sessions:preview-import", input);

export async function previewNativeFolderPlacements(folders: readonly string[]) {
  const placements: FolderPlacement[] = [];
  for (let start = 0; start < folders.length; start += 2000) {
    placements.push(
      ...(await invokeRendererQuery(
        "native-sessions:preview-placement",
        folders.slice(start, start + 2000),
      )),
    );
  }
  return placements;
}

export const ensureFolderProject = (folder: string) =>
  invokePlainCommand(ensureFolderProjectCommand, folder);

export const importNativeConversation = (input: NativeConversationImportInput) =>
  invokePlainCommand(importNativeConversationCommand, input);

/** The native folder dialog is the only source of a replacement working directory. */
export const pickNativeConversationImportDirectory = () =>
  invokePlainCommand(pickImportDirectoryCommand, {
    title: getIntl().formatMessage({
      id: "lib.nativeSessionCatalog.chooseDirectory",
      defaultMessage: "Choose working directory",
    }),
  });

export const readNativeSessionPathContext = () => invokeRendererQuery("shell:path-context:get");

export const readNativeSessionProjects = (after: string | null = null) =>
  invokeRendererQuery("projects:list", { after, first: 100 });
