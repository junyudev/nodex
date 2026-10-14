import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { afterEach, describe } from "vite-plus/test";
import {
  INITIAL_PROJECT_APPEARANCE,
  INITIAL_PROJECT_DESCRIPTION,
  INITIAL_PROJECT_NAME,
} from "../../shared/initial-project-welcome";
import { extractPlainText } from "../../shared/nfm";
import type { Project } from "../../shared/types";
import type {
  DesktopInitialProjectCreateInput,
  DesktopInitialProjectCreateResult,
} from "../project-application/ProjectWorkspace";
import {
  ProjectWorkspace,
  ProjectWorkspaceError,
  type ProjectWorkspaceService,
} from "../project-application/ProjectWorkspace";
import {
  InitialProjectPresentationError,
  InitialProjectBootstrapRuntime,
  live,
} from "./InitialProjectBootstrapRuntime";
import {
  type InitialProjectJournal,
  InitialProjectRecoveryJournal,
  resolveInitialProjectJournalPath,
} from "./initial-project-journal-store";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "nodex-initial-project-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createIdFactory(): () => string {
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
  ];
  return () => {
    const id = ids.shift();
    if (!id) throw new Error("Initial Project test exhausted its identities");
    return id;
  };
}

function makeLatch(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

class FakeProjectWorkspace {
  status: "empty" | "ready" = "empty";
  project: Project | null = null;
  readonly createInputs: DesktopInitialProjectCreateInput[] = [];
  competingWinner = false;
  creationBarrier: {
    readonly started: () => void;
    readonly wait: Promise<void>;
  } | null = null;

  readonly port = {
    readProjectBootstrap: Effect.sync(() => ({ status: this.status })),
    getProject: (projectId: string) =>
      Effect.sync(() => (this.project?.id === projectId ? this.project : null)),
    createInitialProject: (
      input: DesktopInitialProjectCreateInput,
    ): Effect.Effect<DesktopInitialProjectCreateResult, ProjectWorkspaceError> =>
      Effect.tryPromise({
        try: async () => {
          this.createInputs.push(structuredClone(input));
          this.creationBarrier?.started();
          if (this.creationBarrier) await this.creationBarrier.wait;
          if (this.competingWinner) {
            this.status = "ready";
            this.project = makeProject({
              id: "project:competing-winner",
              sourceRoot: "/workspace/competing-winner",
            });
            throw new Error("initial Project lost the catalog race");
          }
          if (!this.project) {
            this.project = makeProject({
              id: input.projectId,
              sourceRoot: input.sources?.[0] ?? "",
            });
            this.status = "ready";
          }
          return { project: this.project };
        },
        catch: (cause) => new ProjectWorkspaceError({ operation: "project.create", cause }),
      }),
  } as unknown as ProjectWorkspaceService;
}

function makeProject(input: { id: string; sourceRoot: string }): Project {
  return {
    id: input.id,
    libraryId: "library:test",
    databaseId: "database:default",
    defaultDatabaseViewId: "view:default",
    lifecycle: "active",
    bindingRevision: 1,
    name: "My Project",
    description: "",
    appearance: {
      color: "black",
      marker: { kind: "icon", icon: "folder" },
    },
    sources: [{ root: input.sourceRoot, order: 0 }],
    primaryWorkspaceRoot: input.sourceRoot,
    pinned: true,
    pinnedOrder: 0,
    created: new Date("2026-07-31T00:00:00.000Z"),
    updated: new Date("2026-07-31T00:00:00.000Z"),
  };
}

const runtimeLayer = (input: {
  readonly root: string;
  readonly workspace: FakeProjectWorkspace;
  readonly createId?: () => string;
}) =>
  live({
    projectsDirectory: join(input.root, "workspace"),
    journalPath: resolveInitialProjectJournalPath(join(input.root, ".nodex")),
    createId: input.createId,
  }).pipe(
    Layer.provide(Layer.succeed(ProjectWorkspace, ProjectWorkspace.of(input.workspace.port))),
  );

const getRuntime = (input: {
  readonly root: string;
  readonly workspace: FakeProjectWorkspace;
  readonly createId?: () => string;
}) =>
  Layer.build(runtimeLayer(input)).pipe(
    Effect.map((context) => Context.get(context, InitialProjectBootstrapRuntime)),
  );

describe("InitialProjectBootstrapRuntime", () => {
  it.effect("creates My Project with source-aware welcome content", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = createTemporaryDirectory();
        const workspace = new FakeProjectWorkspace();
        const presentations: unknown[] = [];
        const runtime = yield* getRuntime({ root, workspace, createId: createIdFactory() });

        yield* runtime.ensure((presentation) =>
          Effect.sync(() => presentations.push(presentation)).pipe(Effect.asVoid),
        );

        const input = workspace.createInputs[0];
        const sourceRoot = join(root, "workspace", "My Project");
        assert.strictEqual(input?.name, "My Project");
        assert.deepEqual(input?.sources, [sourceRoot]);
        assert.strictEqual(input?.starterPage.titleMarkdown, "Welcome to Nodex");
        assert.include(extractPlainText(input?.starterPage.nfm ?? ""), sourceRoot);
        assert.deepEqual(presentations, [
          {
            projectId: input?.projectId,
            starterPageId: input?.starterPage.pageId,
            starterPageTitle: "Welcome to Nodex",
          },
        ]);
        assert.deepEqual(readdirSync(sourceRoot), []);
        assert.isFalse(existsSync(resolveInitialProjectJournalPath(join(root, ".nodex"))));
      }),
    ),
  );

  it.effect("reconciles a committed Project without replaying an old operation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = createTemporaryDirectory();
        const workspace = new FakeProjectWorkspace();
        const first = yield* getRuntime({ root, workspace, createId: createIdFactory() });

        const failure = yield* Effect.flip(
          first.ensure(() =>
            Effect.fail(
              new InitialProjectPresentationError({
                cause: new Error("window session write failed"),
              }),
            ),
          ),
        );
        const presentationFailure = failure.cause;
        assert.isTrue(presentationFailure instanceof InitialProjectPresentationError);
        assert.strictEqual(
          presentationFailure instanceof InitialProjectPresentationError &&
            presentationFailure.cause instanceof Error
            ? presentationFailure.cause.message
            : "",
          "window session write failed",
        );
        const journalPath = resolveInitialProjectJournalPath(join(root, ".nodex"));
        assert.isTrue(existsSync(journalPath));

        const recoveredPresentations: unknown[] = [];
        const recovered = yield* getRuntime({ root, workspace });
        yield* recovered.ensure((presentation) =>
          Effect.sync(() => recoveredPresentations.push(presentation)).pipe(Effect.asVoid),
        );

        assert.strictEqual(workspace.createInputs.length, 1);
        assert.strictEqual(recoveredPresentations.length, 1);
        assert.isFalse(existsSync(journalPath));
        assert.deepEqual(readdirSync(join(root, "workspace", "My Project")), []);
      }),
    ),
  );

  it.effect("renews a legacy recovery operation after an empty authoritative read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = createTemporaryDirectory();
        const sourceRoot = join(root, "workspace", "My Project");
        const journalPath = resolveInitialProjectJournalPath(join(root, ".nodex"));
        const legacyOperationId = "22222222-2222-4222-8222-222222222222";
        const attempt = {
          schemaVersion: 2,
          attemptId: "11111111-1111-4111-8111-111111111111",
          operationId: legacyOperationId,
          payload: {
            projectId: "33333333-3333-4333-8333-333333333333",
            name: INITIAL_PROJECT_NAME,
            description: INITIAL_PROJECT_DESCRIPTION,
            appearance: {
              color: INITIAL_PROJECT_APPEARANCE.color,
              marker: { ...INITIAL_PROJECT_APPEARANCE.marker },
            },
            sources: [sourceRoot],
            starterPage: {
              pageId: "44444444-4444-4444-8444-444444444444",
              documentId: "55555555-5555-4555-8555-555555555555",
              titleMarkdown: "Welcome to Nodex",
              nfm: "Welcome to Nodex",
            },
          },
        } satisfies InitialProjectJournal;
        yield* Effect.promise(() =>
          new InitialProjectRecoveryJournal({ filePath: journalPath }).save(attempt),
        );
        const workspace = new FakeProjectWorkspace();
        const runtime = yield* getRuntime({ root, workspace });

        yield* runtime.ensure(() => Effect.void);

        const operationId = workspace.createInputs[0]?.operationId ?? "";
        assert.notStrictEqual(operationId, legacyOperationId);
        assert.match(operationId, /^nodexop:v1:\d+:\d+:initial-project\.bootstrap:/);
        assert.isFalse(existsSync(journalPath));
      }),
    ),
  );

  it.effect("uses a collision-safe folder without taking over existing content", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = createTemporaryDirectory();
        const projectsDirectory = join(root, "workspace");
        mkdirSync(join(projectsDirectory, "My Project"), { recursive: true });
        const workspace = new FakeProjectWorkspace();
        const runtime = yield* getRuntime({ root, workspace, createId: createIdFactory() });

        yield* runtime.ensure(() => Effect.void);

        assert.deepEqual(workspace.createInputs[0]?.sources, [
          join(projectsDirectory, "My Project 2"),
        ]);
        assert.deepEqual(readdirSync(join(projectsDirectory, "My Project")), []);
      }),
    ),
  );

  it.effect("accepts a competing initial Project and retains its unused directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = createTemporaryDirectory();
        const workspace = new FakeProjectWorkspace();
        workspace.competingWinner = true;
        const runtime = yield* getRuntime({ root, workspace, createId: createIdFactory() });
        let presented = false;

        yield* runtime.ensure(() => Effect.sync(() => void (presented = true)));

        assert.isFalse(presented);
        assert.isTrue(existsSync(join(root, "workspace", "My Project")));
        assert.deepEqual(readdirSync(join(root, "workspace", "My Project")), []);
        assert.isFalse(existsSync(resolveInitialProjectJournalPath(join(root, ".nodex"))));
      }),
    ),
  );

  it.effect("serializes concurrent bootstrap attempts into one durable transaction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = createTemporaryDirectory();
        const workspace = new FakeProjectWorkspace();
        const started = makeLatch();
        const release = makeLatch();
        workspace.creationBarrier = { started: started.release, wait: release.promise };
        const runtime = yield* getRuntime({ root, workspace, createId: createIdFactory() });
        const presentations: unknown[] = [];
        const onProvisioned = (presentation: unknown) =>
          Effect.sync(() => presentations.push(presentation)).pipe(Effect.asVoid);

        const first = yield* Effect.forkChild(runtime.ensure(onProvisioned));
        yield* Effect.tryPromise(() => started.promise);
        const second = yield* Effect.forkChild(runtime.ensure(onProvisioned));
        release.release();
        yield* Fiber.join(first);
        yield* Fiber.join(second);

        assert.strictEqual(workspace.createInputs.length, 1);
        assert.strictEqual(presentations.length, 1);
      }),
    ),
  );

  it.effect("drains the admitted transaction and rejects queued work on Scope close", () =>
    Effect.gen(function* () {
      const root = createTemporaryDirectory();
      const workspace = new FakeProjectWorkspace();
      const started = makeLatch();
      const release = makeLatch();
      workspace.creationBarrier = { started: started.release, wait: release.promise };
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        runtimeLayer({ root, workspace, createId: createIdFactory() }),
        scope,
      );
      const runtime = Context.get(context, InitialProjectBootstrapRuntime);
      let presentations = 0;
      const onProvisioned = () => Effect.sync(() => void (presentations += 1));

      const first = yield* Effect.forkChild(runtime.ensure(onProvisioned));
      yield* Effect.tryPromise(() => started.promise);
      const queued = yield* Effect.forkChild(runtime.ensure(onProvisioned));
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* Effect.yieldNow;
      release.release();

      yield* Fiber.join(first);
      const queuedExit = yield* Effect.exit(Fiber.join(queued));
      assert.isTrue(Exit.isFailure(queuedExit));
      yield* Fiber.join(closing);
      const closedExit = yield* Effect.exit(runtime.ensure(onProvisioned));
      assert.isTrue(Exit.isFailure(closedExit));
      assert.strictEqual(workspace.createInputs.length, 1);
      assert.strictEqual(presentations, 1);
    }),
  );
});
