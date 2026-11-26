import { basename, join } from "node:path";
import * as Effect from "effect/Effect";
import { v5 } from "uuid";
import {
  areWorkspacePathsEquivalent,
  normalizeCodexPathIdentity,
} from "../../shared/codex-workspace-paths";
import type { FolderPlacement } from "../../shared/folder-placement";
import type { ProjectWindow } from "../../shared/types";
import {
  isOfferedProjectFolder,
  projectDiscoveryPlaces,
  repositoryFromRemoteUrl,
} from "../agent-backend/project-discovery";
import { SessionFolderError } from "../agent-backend/SessionFolders";
import type { MainConfigValue } from "../app/MainConfig";
import { createOperationId } from "../core-runtime/operation-identity";
import { resolveNodexProjectsDirectory } from "../nodex-projects-directory";
import {
  probeWorkspaceFolder,
  type WorkspaceFolderIdentity,
} from "../platform/node/GitRepositoryProbe";
import type { ProjectWorkspace } from "./ProjectWorkspace";

type PlacementProjects = Pick<
  ProjectWorkspace["Service"],
  "getProject" | "listProjectWindow" | "createProject"
>;
type PlacementPlaces = ReturnType<typeof projectDiscoveryPlaces>;
type ProjectSource = {
  readonly folder: WorkspaceFolderIdentity;
  readonly projectId: string;
  readonly name: string;
  readonly active: boolean;
};

export const projectForFolder = (root: string) =>
  v5(`nodex:chat-folder:${normalizeCodexPathIdentity(root)}`, v5.URL);

export const folderPlacementPlaces = (config: MainConfigValue): PlacementPlaces => {
  const places = projectDiscoveryPlaces(config.nodexHome);
  return {
    ...places,
    temporary: [...places.temporary, join(resolveNodexProjectsDirectory(config), "Chats")],
  };
};

const contains = (root: string, folder: string) => {
  const prefix = normalizeCodexPathIdentity(root);
  return (
    areWorkspacePathsEquivalent(root, folder) ||
    normalizeCodexPathIdentity(folder).startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
  );
};

const sameRepository = (left: WorkspaceFolderIdentity, right: WorkspaceFolderIdentity) =>
  left.repository !== null &&
  right.repository !== null &&
  areWorkspacePathsEquivalent(
    left.repository.commonDirectory ?? left.repository.root,
    right.repository.commonDirectory ?? right.repository.root,
  );

/** The closest active source wins, with directory containment ahead of repository identity. */
export function resolveFolderPlacement(
  folder: WorkspaceFolderIdentity | null,
  sources: readonly ProjectSource[],
  places: PlacementPlaces,
  explicit = false,
): FolderPlacement {
  if (!folder) return { kind: "missing" };
  const matches = sources.flatMap((source) => {
    const direct = contains(source.folder.path, folder.path);
    return direct || sameRepository(source.folder, folder)
      ? [{ source, priority: direct ? source.folder.path.length : 0 }]
      : [];
  });
  const owner = matches
    .filter(({ source }) => source.active)
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.source.projectId.localeCompare(right.source.projectId),
    )[0]?.source;
  if (owner) return { kind: "project", projectId: owner.projectId, name: owner.name };
  const root = folder.repository?.root ?? folder.path;
  if (
    (!explicit && matches.length > 0) ||
    (!explicit &&
      (!isOfferedProjectFolder(folder.path, places) ||
        (folder.alias !== undefined && !isOfferedProjectFolder(folder.alias, places)) ||
        !isOfferedProjectFolder(root, places)))
  )
    return { kind: "chats" };
  return {
    kind: "new-project",
    projectId: matches.some(({ source }) => source.projectId === projectForFolder(root))
      ? v5(
          JSON.stringify([
            "nodex:replacement-folder",
            normalizeCodexPathIdentity(root),
            ...matches.map(({ source }) => source.projectId).sort(),
          ]),
          v5.URL,
        )
      : projectForFolder(root),
    root,
    name: repositoryFromRemoteUrl(folder.repository?.remoteUrl ?? null) ?? (basename(root) || root),
  };
}

/** One read-only placement snapshot can serve every distinct folder in a batch. */
export const readFolderPlacements = Effect.fn("FolderPlacement.read")(function* (
  projects: Pick<PlacementProjects, "listProjectWindow">,
  places: PlacementPlaces,
  folders: readonly string[],
  explicit = false,
) {
  const paths = new Set(folders);
  if (paths.size === 0) return [];
  const sources: {
    path: string;
    projectId: string;
    name: string;
    active: boolean;
  }[] = [];
  let after: string | null = null;
  do {
    const page: ProjectWindow = yield* projects.listProjectWindow({ after, includeArchived: true });
    for (const project of page.items) {
      for (const source of project.sources) {
        if (source.kind !== "directory") continue;
        paths.add(source.path);
        sources.push({
          path: source.path,
          projectId: project.id,
          name: project.name,
          active: project.lifecycle === "active",
        });
      }
    }
    after = page.nextCursor;
  } while (after !== null);

  const locations = new Map(
    yield* Effect.forEach(
      paths,
      (path) =>
        Effect.promise(() => probeWorkspaceFolder(path)).pipe(
          Effect.map((folder) => [path, folder] as const),
        ),
      { concurrency: 8 },
    ),
  );
  const projectSources = sources.map(({ path, ...source }) => {
    const folder = locations.get(path) ?? { path, repository: null };
    return { ...source, folder };
  });
  return folders.map((folder) =>
    resolveFolderPlacement(locations.get(folder) ?? null, projectSources, places, explicit),
  );
});

/** Multiple commands can create the same Project without giving it competing identities. */
export const ensurePlacedProject = Effect.fn("FolderPlacement.ensurePlacedProject")(function* (
  projects: Pick<PlacementProjects, "getProject" | "createProject">,
  placement: Extract<FolderPlacement, { kind: "new-project" }>,
  name?: string,
): Effect.fn.Return<
  Exclude<FolderPlacement, { kind: "missing" | "new-project" }>,
  Effect.Error<ReturnType<PlacementProjects["createProject"]>> | SessionFolderError
> {
  const { projectId, root } = placement;
  const existing = yield* projects.getProject(projectId);
  const project =
    existing ??
    (yield* projects
      .createProject({
        operationId: createOperationId("folder-placement.create-project"),
        payload: { projectId, input: { name: name?.trim() || placement.name, sources: [root] } },
      })
      .pipe(
        Effect.map(({ value }) => value),
        Effect.catch((cause) =>
          projects
            .getProject(projectId)
            .pipe(
              Effect.flatMap((winner) => (winner ? Effect.succeed(winner) : Effect.fail(cause))),
            ),
        ),
      ));
  if (project.lifecycle !== "active") return { kind: "chats" };
  if (
    !project.sources.some(
      (source) => source.kind === "directory" && areWorkspacePathsEquivalent(source.path, root),
    )
  )
    return yield* new SessionFolderError({
      message: "The Project for this folder is unavailable",
      cause: undefined,
    });
  return { kind: "project", projectId, name: project.name };
});

/** Re-resolve against current Projects, and use the same identity across simultaneous creators. */
export const resolveAndEnsureFolderProject = Effect.fn("FolderPlacement.ensure")(function* (input: {
  readonly projects: PlacementProjects;
  readonly places: PlacementPlaces;
  readonly folder: string;
  /** Explicit folder choices can create Projects in places excluded from discovery. */
  readonly explicit?: boolean;
  readonly name?: string;
}): Effect.fn.Return<
  Exclude<FolderPlacement, { kind: "new-project" }>,
  Effect.Error<ReturnType<PlacementProjects["createProject"]>> | SessionFolderError
> {
  const { projects, places, folder, explicit, name } = input;
  const [placement] = yield* readFolderPlacements(projects, places, [folder], explicit);
  if (!placement) return { kind: "missing" };
  if (placement.kind !== "new-project") return placement;

  return yield* ensurePlacedProject(projects, placement, name);
});
