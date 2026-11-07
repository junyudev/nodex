import { describe, expect, test, vi } from "vite-plus/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import {
  createProjectWithDefaultSource,
  DefaultProjectSourceError,
  findAvailableDefaultProjectSource,
  sanitizeDefaultProjectDirectoryName,
} from "./default-project-source";
import type { Project, ProjectCreateInput } from "../shared/types";
import { resolveNodexProjectsDirectory } from "./nodex-projects-directory";

const PROJECT = { id: "project-created" } as Project;
const DOCUMENTS_DIRECTORY = resolve("/Users/test/Documents");
const PROJECTS_DIRECTORY = resolveNodexProjectsDirectory({
  documentsDirectory: DOCUMENTS_DIRECTORY,
});

describe("default Project sources", () => {
  test("sanitizes the generated folder name using the desktop filesystem contract", () => {
    expect(sanitizeDefaultProjectDirectoryName("")).toBe("New project");
    expect(sanitizeDefaultProjectDirectoryName("  Roadmap:*?  ")).toBe("Roadmap___");
    expect(sanitizeDefaultProjectDirectoryName("nested/research. ")).toBe("research");
    expect(sanitizeDefaultProjectDirectoryName("CON")).toBe("_CON");
    expect(sanitizeDefaultProjectDirectoryName("\u0000. ")).toBe("_");
  });

  it.effect("allocates the first free Documents/Nodex folder with numeric suffixes", () =>
    Effect.gen(function* () {
      const occupied = new Set([
        join(DOCUMENTS_DIRECTORY, "Nodex/New project"),
        join(DOCUMENTS_DIRECTORY, "Nodex/New project 2"),
      ]);

      const selected = yield* findAvailableDefaultProjectSource(
        PROJECTS_DIRECTORY,
        "New project",
        (candidate) => Effect.succeed(occupied.has(candidate)),
      );
      expect(selected).toBe(join(DOCUMENTS_DIRECTORY, "Nodex/New project 3"));
    }),
  );

  it.effect("does not let a legacy Documents folder consume the nested name", () =>
    Effect.gen(function* () {
      const occupied = new Set([join(DOCUMENTS_DIRECTORY, "Launch plan")]);

      const selected = yield* findAvailableDefaultProjectSource(
        PROJECTS_DIRECTORY,
        "Launch plan",
        (candidate) => Effect.succeed(occupied.has(candidate)),
      );
      expect(selected).toBe(join(DOCUMENTS_DIRECTORY, "Nodex/Launch plan"));
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

      expect(createDirectory).toHaveBeenCalledWith(join(DOCUMENTS_DIRECTORY, "Nodex/Launch plan"));
      expect(initializeRepository).toHaveBeenCalledWith(
        join(DOCUMENTS_DIRECTORY, "Nodex/Launch plan"),
      );
      expect(createProject).toHaveBeenCalledWith({
        appearance: {
          color: "black",
          marker: { kind: "icon", icon: "folder" },
        },
        name: "Launch plan",
        sources: [join(DOCUMENTS_DIRECTORY, "Nodex/Launch plan")],
      });
    }),
  );

  it.effect("creates the default folder before persisting an unnamed Project", () =>
    Effect.acquireUseRelease(
      Effect.tryPromise(() => mkdtemp(join(tmpdir(), "nodex-default-project-source-"))),
      (documentsDirectory) =>
        Effect.gen(function* () {
          const createProject = vi.fn(() => Effect.succeed(PROJECT));

          const projectsDirectory = resolveNodexProjectsDirectory({ documentsDirectory });
          yield* createProjectWithDefaultSource(
            { name: "", sources: [] },
            { projectsDirectory, createProject },
          );

          const source = join(projectsDirectory, "New project");
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
