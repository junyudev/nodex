import { searchPathsEqual } from "../../shared/file-search-paths";
import type { Project, ProjectCreateInput, ProjectWindow, ProjectWindowInput } from "./types";
import { invokeRendererQuery } from "./renderer-command";
import { pickCommandPaletteProjectDirectory } from "./command-palette-workspace-operations";

interface OpenProjectFolderPorts {
  readonly chooseFolder: () => Promise<string | null>;
  readonly readProjects: (input: ProjectWindowInput) => Promise<ProjectWindow>;
  readonly createProject: (input: ProjectCreateInput) => Promise<Project | null>;
  readonly startChat: (projectId: string) => Promise<void>;
}

/** Resolve the whole active Project catalog before creating a Project for a selected folder. */
export async function openCommandPaletteProjectFolder(
  ports: OpenProjectFolderPorts,
): Promise<void> {
  const folder = await ports.chooseFolder();
  if (!folder) return;
  let after: string | null = null;
  const cursors = new Set<string>();
  do {
    const window = await ports.readProjects({ first: 100, after });
    const existing = window.items.find(
      (project) =>
        project.sources.length === 1 && searchPathsEqual(project.sources[0]!.root, folder),
    );
    if (existing) {
      await ports.startChat(existing.id);
      return;
    }
    after = window.nextCursor;
    if (after && cursors.has(after))
      throw new Error("Project list changed. Try opening the folder again");
    if (after) cursors.add(after);
  } while (after);
  const name =
    folder
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) || folder;
  const project = await ports.createProject({ name, sources: [folder] });
  if (!project) throw new Error("Could not create project");
  await ports.startChat(project.id);
}

export function openCommandPaletteFolder(
  input: Pick<OpenProjectFolderPorts, "createProject" | "startChat">,
): Promise<void> {
  return openCommandPaletteProjectFolder({
    ...input,
    chooseFolder: pickCommandPaletteProjectDirectory,
    readProjects: (window) => invokeRendererQuery("projects:list", window),
  });
}
