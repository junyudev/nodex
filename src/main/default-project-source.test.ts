import { describe, expect, test, vi } from "vite-plus/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import {
  createProjectWithDefaultSource,
  defaultProjectDirectoryName,
  DefaultProjectSourceError,
  findAvailableDefaultProjectSource,
} from "./default-project-source";
import type { Project, ProjectCreateInput } from "../shared/types";
import { resolveNodexProjectsDirectory } from "./nodex-projects-directory";

const PROJECT = { id: "project-created" } as Project;
const DOCUMENTS_DIRECTORY = resolve("/Users/test/Documents");
/** A real Profile's projects directory under the given Documents directory. */
const realProjectsDirectory = (documentsPath: string) =>
  resolveNodexProjectsDirectory({
    projectsDirectory: null,
    documentsPath,
    isolatedRunId: null,
    nodexHome: "/Users/test/.nodex",
  });
const PROJECTS_DIRECTORY = realProjectsDirectory(DOCUMENTS_DIRECTORY);

describe("default Project sources", () => {
  test("names the generated folder in lowercase ASCII without spaces", () => {
    expect(defaultProjectDirectoryName("Launch Plan")).toBe("launch-plan");
    expect(defaultProjectDirectoryName("  Roadmap:*?  ")).toBe("roadmap");
    expect(defaultProjectDirectoryName("../nested/research. ")).toBe("nested-research");
    expect(defaultProjectDirectoryName("我的 App 项目")).toBe("app");
    expect(defaultProjectDirectoryName("我的项目")).toBe("new-project");
    expect(defaultProjectDirectoryName("")).toBe("new-project");
  });

  it.effect("allocates the first free Documents/Nodex folder with numeric suffixes", () =>
    Effect.gen(function* () {
      const occupied = new Set([
        join(DOCUMENTS_DIRECTORY, "Nodex/new-project"),
        join(DOCUMENTS_DIRECTORY, "Nodex/new-project-2"),
      ]);

      const selected = yield* findAvailableDefaultProjectSource(
        PROJECTS_DIRECTORY,
        "new-project",
        (candidate) => Effect.succeed(occupied.has(candidate)),
      );
      expect(selected).toBe(join(DOCUMENTS_DIRECTORY, "Nodex/new-project-3"));
    }),
  );

  it.effect("does not let a legacy Documents folder consume the nested name", () =>
    Effect.gen(function* () {
      const occupied = new Set([join(DOCUMENTS_DIRECTORY, "launch-plan")]);

      const selected = yield* findAvailableDefaultProjectSource(
        PROJECTS_DIRECTORY,
        "launch-plan",
        (candidate) => Effect.succeed(occupied.has(candidate)),
      );
      expect(selected).toBe(join(DOCUMENTS_DIRECTORY, "Nodex/launch-plan"));
    }),
  );

  it.effect("preserves explicitly selected sources without provisioning a folder", () =>
    Effect.gen(function* () {
      const createProject = vi.fn(() => Effect.succeed(PROJECT));
      const createDirectory = vi.fn(() => Effect.void);
      const initializeRepository = vi.fn(() => Effect.void);
      const input: ProjectCreateInput = {
        name: "",
        sources: ["/workspace/existing"],
      };

      const created = yield* createProjectWithDefaultSource(input, {
        projectsDirectory: PROJECTS_DIRECTORY,
        createProject,
        createDirectory,
        initializeRepository,
      });
      expect(created).toBe(PROJECT);

      expect(createProject).toHaveBeenCalledWith(input);
      expect(createDirectory).not.toHaveBeenCalled();
      expect(initializeRepository).not.toHaveBeenCalled();
    }),
  );

  it.effect("provisions and binds a default source when the dialog submits no folders", () =>
    Effect.gen(function* () {
      const createProject = vi.fn(() => Effect.succeed(PROJECT));
      const createDirectory = vi.fn(() => Effect.void);
      const initializeRepository = vi.fn(() =>
        Effect.fail(
          new DefaultProjectSourceError({
            operation: "initialize-test",
            cause: new Error("git unavailable"),
          }),
        ),
      );

      const created = yield* createProjectWithDefaultSource(
        {
          appearance: {
            color: "black",
            marker: { kind: "icon", icon: "folder" },
          },
          name: "Launch plan",
          sources: [],
        },
        {
          projectsDirectory: PROJECTS_DIRECTORY,
          createProject,
          createDirectory,
          pathExists: () => Effect.succeed(false),
          initializeRepository,
        },
      );
      expect(created).toBe(PROJECT);

      expect(createDirectory).toHaveBeenCalledWith(join(DOCUMENTS_DIRECTORY, "Nodex/launch-plan"));
      expect(initializeRepository).toHaveBeenCalledWith(
        join(DOCUMENTS_DIRECTORY, "Nodex/launch-plan"),
      );
      expect(createProject).toHaveBeenCalledWith({
        appearance: {
          color: "black",
          marker: { kind: "icon", icon: "folder" },
        },
        name: "Launch plan",
        sources: [join(DOCUMENTS_DIRECTORY, "Nodex/launch-plan")],
      });
    }),
  );

  it.effect("creates the default folder before persisting an unnamed Project", () =>
    Effect.acquireUseRelease(
      Effect.tryPromise(() => mkdtemp(join(tmpdir(), "nodex-default-project-source-"))),
      (documentsDirectory) =>
        Effect.gen(function* () {
          const createProject = vi.fn(() => Effect.succeed(PROJECT));

          const projectsDirectory = realProjectsDirectory(documentsDirectory);
          yield* createProjectWithDefaultSource(
            { name: "", sources: [] },
            { projectsDirectory, createProject },
          );

          const source = join(projectsDirectory, "new-project");
          const sourceMetadata = yield* Effect.tryPromise(() => stat(source));
          expect(sourceMetadata.isDirectory()).toBe(true);
          expect(createProject).toHaveBeenCalledWith({
            name: "",
            sources: [source],
          });
        }),
      (documentsDirectory) =>
        Effect.tryPromise(() => rm(documentsDirectory, { recursive: true, force: true })).pipe(
          Effect.ignore,
        ),
    ),
  );
});
