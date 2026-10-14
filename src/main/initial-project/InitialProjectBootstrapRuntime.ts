import { basename, dirname, join } from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  INITIAL_PROJECT_APPEARANCE,
  INITIAL_PROJECT_DESCRIPTION,
  INITIAL_PROJECT_FOLDER_BASENAME,
  INITIAL_PROJECT_NAME,
  type InitialProjectPresentation,
  renderInitialProjectWelcomePage,
} from "../../shared/initial-project-welcome";
import {
  ProjectWorkspace,
  type DesktopInitialProjectCreateResult,
  type ProjectWorkspaceError,
} from "../project-application/ProjectWorkspace";
import {
  claimInitialProjectDirectory,
  createInitialProjectId,
  ensureRealDirectory,
  initialProjectMarkerMatches,
  inspectInitialProjectDirectory,
  removeOwnedInitialProjectMarker,
  writeInitialProjectMarker,
} from "./initial-project-filesystem";
import {
  type InitialProjectJournal,
  InitialProjectRecoveryJournal,
} from "./initial-project-journal-store";
import { createOperationId } from "../core-runtime/operation-identity";

export class InitialProjectBootstrapError extends Schema.TaggedError<InitialProjectBootstrapError>()(
  "InitialProjectBootstrapError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class InitialProjectPresentationError extends Schema.TaggedError<InitialProjectPresentationError>()(
  "InitialProjectPresentationError",
  { cause: Schema.Defect() },
) {}

export interface InitialProjectBootstrapRuntimeOptions {
  readonly projectsDirectory: string;
  readonly journalPath: string;
  readonly createId?: () => string;
}

export class InitialProjectBootstrapRuntime extends Context.Service<
  InitialProjectBootstrapRuntime,
  {
    readonly ensure: (
      onProvisioned: (
        presentation: InitialProjectPresentation,
      ) => Effect.Effect<void, InitialProjectPresentationError>,
    ) => Effect.Effect<void, InitialProjectBootstrapError>;
  }
>()("nodex/main/initial-project/InitialProjectBootstrapRuntime") {}

const runtimeError = (operation: string, cause: unknown): InitialProjectBootstrapError =>
  new InitialProjectBootstrapError({ operation, cause });

const fromPromise = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => runtimeError(operation, cause),
  });

const make = (options: InitialProjectBootstrapRuntimeOptions) =>
  Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace;
    const journal = new InitialProjectRecoveryJournal({ filePath: options.journalPath });
    const createId = options.createId ?? createInitialProjectId;
    const admission = yield* Semaphore.make(1);
    const closed = yield* Ref.make(false);

    const ensureOpen = Effect.gen(function* () {
      if (!(yield* Ref.get(closed))) return;
      return yield* runtimeError(
        "ensure.closed",
        new Error("Initial Project bootstrap runtime is closed"),
      );
    });

    const saveJournal = (attempt: InitialProjectJournal) =>
      fromPromise("journal.save", () => journal.save(attempt));

    const clearJournal = fromPromise("journal.clear", () => journal.clear());
    const project = <A>(operation: string, effect: Effect.Effect<A, ProjectWorkspaceError>) =>
      effect.pipe(Effect.mapError((cause) => runtimeError(operation, cause)));

    const createAttempt = (
      sourceRoot: string,
    ): Effect.Effect<InitialProjectJournal, InitialProjectBootstrapError> =>
      Effect.try({
        try: () => {
          const page = renderInitialProjectWelcomePage({ sourceRoot });
          return {
            schemaVersion: 2,
            attemptId: createId(),
            operationId: createOperationId("initial-project.bootstrap"),
            payload: {
              projectId: createId(),
              name: INITIAL_PROJECT_NAME,
              description: INITIAL_PROJECT_DESCRIPTION,
              appearance: {
                color: INITIAL_PROJECT_APPEARANCE.color,
                marker: { ...INITIAL_PROJECT_APPEARANCE.marker },
              },
              sources: [sourceRoot],
              starterPage: {
                pageId: createId(),
                documentId: createId(),
                titleMarkdown: page.titleMarkdown,
                nfm: page.nfm,
              },
            },
          } satisfies InitialProjectJournal;
        },
        catch: (cause) => runtimeError("attempt.create", cause),
      });

    const retargetAttempt = (
      attempt: InitialProjectJournal,
      sourceRoot: string,
    ): InitialProjectJournal => {
      const page = renderInitialProjectWelcomePage({ sourceRoot });
      return {
        ...attempt,
        payload: {
          ...attempt.payload,
          sources: [sourceRoot],
          starterPage: {
            ...attempt.payload.starterPage,
            titleMarkdown: page.titleMarkdown,
            nfm: page.nfm,
          },
        },
      };
    };

    const renewAttemptOperation = (attempt: InitialProjectJournal): InitialProjectJournal => ({
      ...attempt,
      operationId: createOperationId("initial-project.bootstrap"),
    });

    const cleanupAttempt = Effect.fn("InitialProjectBootstrapRuntime.cleanupAttempt")(function* (
      attempt: InitialProjectJournal,
    ) {
      const sourceRoot = attempt.payload.sources[0];
      if (sourceRoot) {
        yield* fromPromise("marker.remove", () =>
          removeOwnedInitialProjectMarker(sourceRoot, attempt),
        );
      }
      yield* clearJournal;
    });

    const createInitialProject = Effect.fn("InitialProjectBootstrapRuntime.createInitialProject")(
      function* (attempt: InitialProjectJournal) {
        return yield* project(
          "project.create",
          workspace.createInitialProject({
            operationId: attempt.operationId,
            projectId: attempt.payload.projectId,
            name: attempt.payload.name,
            description: attempt.payload.description,
            appearance: attempt.payload.appearance,
            sources: attempt.payload.sources,
            starterPage: attempt.payload.starterPage,
          }),
        );
      },
    );

    const persistPresentation = Effect.fn("InitialProjectBootstrapRuntime.persistPresentation")(
      function* (
        attempt: InitialProjectJournal,
        created: DesktopInitialProjectCreateResult,
        onProvisioned: (
          presentation: InitialProjectPresentation,
        ) => Effect.Effect<void, InitialProjectPresentationError>,
      ) {
        yield* onProvisioned({
          projectId: created.project.id,
          starterPageId: attempt.payload.starterPage.pageId,
          starterPageTitle: attempt.payload.starterPage.titleMarkdown,
        }).pipe(Effect.mapError((cause) => runtimeError("presentation.persist", cause)));
      },
    );

    const prepareAttemptDirectory = Effect.fn(
      "InitialProjectBootstrapRuntime.prepareAttemptDirectory",
    )(function* (initialAttempt: InitialProjectJournal) {
      const initialRoot = initialAttempt.payload.sources[0];
      if (!initialRoot) {
        return yield* runtimeError(
          "directory.prepare",
          new Error("Initial Project recovery has no source root"),
        );
      }
      const initialState = yield* fromPromise("directory.inspect", () =>
        inspectInitialProjectDirectory(initialRoot),
      );
      if (
        initialState === "real" &&
        (yield* fromPromise("marker.inspect", () =>
          initialProjectMarkerMatches(initialRoot, initialAttempt),
        ))
      ) {
        return initialAttempt;
      }
      if (initialState === "missing") {
        const created = yield* fromPromise("directory.claim", () =>
          claimInitialProjectDirectory(initialRoot),
        );
        if (created) {
          yield* fromPromise("marker.write", () =>
            writeInitialProjectMarker(initialRoot, initialAttempt),
          );
          return initialAttempt;
        }
      }

      const parent = dirname(initialRoot);
      yield* fromPromise("directory.ensure-parent", () => ensureRealDirectory(parent));
      for (let suffix = 1; ; suffix += 1) {
        const directoryName =
          suffix === 1
            ? INITIAL_PROJECT_FOLDER_BASENAME
            : `${INITIAL_PROJECT_FOLDER_BASENAME} ${suffix}`;
        const sourceRoot = join(parent, directoryName);
        const attempt =
          sourceRoot === initialRoot ? initialAttempt : retargetAttempt(initialAttempt, sourceRoot);
        if (attempt !== initialAttempt) yield* saveJournal(attempt);

        const state = yield* fromPromise("directory.inspect", () =>
          inspectInitialProjectDirectory(sourceRoot),
        );
        if (
          state === "real" &&
          (yield* fromPromise("marker.inspect", () =>
            initialProjectMarkerMatches(sourceRoot, attempt),
          ))
        ) {
          return attempt;
        }
        if (state !== "missing") continue;
        if (
          !(yield* fromPromise("directory.claim", () => claimInitialProjectDirectory(sourceRoot)))
        ) {
          continue;
        }
        yield* fromPromise("marker.write", () => writeInitialProjectMarker(sourceRoot, attempt));
        return attempt;
      }
    });

    const finishReadyCatalogAttempt = Effect.fn(
      "InitialProjectBootstrapRuntime.finishReadyCatalogAttempt",
    )(function* (
      attempt: InitialProjectJournal,
      onProvisioned: (
        presentation: InitialProjectPresentation,
      ) => Effect.Effect<void, InitialProjectPresentationError>,
    ) {
      const ownProject = yield* project(
        "project.read",
        workspace.getProject(attempt.payload.projectId),
      );
      if (!ownProject) {
        yield* cleanupAttempt(attempt);
        yield* Effect.logInfo("Accepted another client as the initial Project winner").pipe(
          Effect.annotateLogs({ attemptId: attempt.attemptId }),
        );
        return;
      }

      yield* persistPresentation(attempt, { project: ownProject }, onProvisioned);
      yield* cleanupAttempt(attempt);
    });

    const commitAttempt = Effect.fn("InitialProjectBootstrapRuntime.commitAttempt")(function* (
      attempt: InitialProjectJournal,
      onProvisioned: (
        presentation: InitialProjectPresentation,
      ) => Effect.Effect<void, InitialProjectPresentationError>,
    ) {
      const created = yield* createInitialProject(attempt).pipe(
        Effect.catch((initialError) =>
          Effect.gen(function* () {
            const ownProject = yield* project(
              "project.read",
              workspace.getProject(attempt.payload.projectId),
            );
            if (ownProject) return yield* createInitialProject(attempt);

            const bootstrap = yield* project(
              "project.read-bootstrap",
              workspace.readProjectBootstrap,
            );
            if (bootstrap.status !== "ready") return yield* initialError;
            yield* cleanupAttempt(attempt);
            yield* Effect.logInfo("Accepted another client as the initial Project winner").pipe(
              Effect.annotateLogs({ attemptId: attempt.attemptId }),
            );
            return null;
          }),
        ),
      );
      if (!created) return;

      yield* persistPresentation(attempt, created, onProvisioned);
      yield* cleanupAttempt(attempt);
      yield* Effect.logInfo("Initial Project is ready").pipe(
        Effect.annotateLogs({
          projectId: created.project.id,
          sourceFolderName: basename(attempt.payload.sources[0] ?? ""),
        }),
      );
    });

    const run = Effect.fn("InitialProjectBootstrapRuntime.ensure")(function* (
      onProvisioned: (
        presentation: InitialProjectPresentation,
      ) => Effect.Effect<void, InitialProjectPresentationError>,
    ) {
      yield* ensureOpen;
      const bootstrap = yield* project("project.read-bootstrap", workspace.readProjectBootstrap);
      const quarantineTimestamp = yield* Clock.currentTimeMillis;
      let attempt = yield* fromPromise("journal.load", () => journal.load(quarantineTimestamp));

      if (!attempt && bootstrap.status === "ready") return;
      if (attempt && bootstrap.status === "ready") {
        yield* finishReadyCatalogAttempt(attempt, onProvisioned);
        return;
      }

      yield* fromPromise("directory.ensure-projects", () =>
        ensureRealDirectory(options.projectsDirectory),
      );
      if (!attempt) {
        attempt = yield* createAttempt(
          join(options.projectsDirectory, INITIAL_PROJECT_FOLDER_BASENAME),
        );
        yield* saveJournal(attempt);
      } else {
        // An empty authoritative catalog proves the previous episode did not
        // commit. Renewing here keeps arbitrarily old recovery journals safe
        // without retaining their receipts forever.
        attempt = renewAttemptOperation(attempt);
        yield* saveJournal(attempt);
      }
      const prepared = yield* prepareAttemptDirectory(attempt);
      yield* commitAttempt(prepared, onProvisioned);
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Ref.set(closed, true);
        yield* admission.withPermits(1)(Effect.void);
      }),
    );

    return InitialProjectBootstrapRuntime.of({
      ensure: (onProvisioned) => admission.withPermits(1)(run(onProvisioned)),
    });
  });

export const live = (
  options: InitialProjectBootstrapRuntimeOptions,
): Layer.Layer<InitialProjectBootstrapRuntime, never, ProjectWorkspace> =>
  Layer.effect(InitialProjectBootstrapRuntime, make(options));
