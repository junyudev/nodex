export { workspaceDirectoryQueryOptions as commandPaletteDirectoryQueryOptions } from "./query-options";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const chooseSearchDirectoryCommand = defineRendererCommand({
  key: "command_palette.open_folder",
  channel: "workspace:pick-directory",
  authority: "external",
  owner: "CommandPalette",
  protocol: { kind: "returned_value" },
});

/** The global Open folder action uses the native local directory picker. */
export const pickCommandPaletteProjectDirectory = () =>
  invokePlainCommand(chooseSearchDirectoryCommand, { title: "Open folder" });

/** Home shorthand is resolved by the selected host, never by the renderer's computer. */
export async function resolveCommandPaletteFilePath(hostId: string, path: string): Promise<string> {
  if (!path.startsWith("~/") && !path.startsWith("~\\")) return path;
  const home = await invokeRendererQuery("workspace-directory-entries", {
    hostId,
    workspaceRoot: "~",
    directoriesOnly: true,
  });
  if (!home.workspaceRoot) throw new Error("Couldn’t resolve the home directory");
  return `${home.workspaceRoot.replace(/[\\/]+$/u, "")}/${path.slice(2)}`;
}
