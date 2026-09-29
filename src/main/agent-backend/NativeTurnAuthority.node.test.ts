import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CoreModules } from "../core-runtime/CoreModules";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import type { ProjectWorkspaceApplyInput } from "../core-client/types";
import { make } from "./NativeTurnAuthority";
import {
  isBoundedOperationId,
  OPERATION_IDENTITY_WINDOW_MS,
} from "../../shared/operation-identity";

const setup = (projectId: string | null, mode: string | null) => {
  const applies: ProjectWorkspaceApplyInput[] = [];
  let frozen = false;
  let currentMode = mode;
  let frozenMode = mode;
  let readOnly = false;
  return {
    applies,
    setMode: (next: string | null) => {
      currentMode = next;
    },
    owner: make.pipe(
      Effect.provideService(ProjectWorkspace, {
        readThreadExecutionContext: () =>
          Effect.succeed({ projectId, permissionMode: currentMode }),
        getThread: () =>
          Effect.succeed({
            threadId: "native",
            projectId,
            backendBinding: { kind: "claude", instanceConfigId: "work" },
            archived: false,
            parentThreadId: null,
          }),
      } as never),
      Effect.provideService(CoreModules, {
        workspace: {
          apply: (command: ProjectWorkspaceApplyInput) =>
            Effect.sync(() => {
              applies.push(command);
              frozen = true;
              frozenMode = currentMode;
              if (command.intent.kind === "freeze_turn_authority")
                readOnly = command.intent.read_only;
              return {};
            }),
          read: () =>
            Effect.succeed({
              value: {
                kind: "turn_authority",
                resolution: {
                  persisted: frozen,
                  frozen_at_ms: frozen ? 5 : null,
                  read_only: readOnly,
                  authority: frozen
                    ? {
                        thread_id: "native",
                        turn_id: "accepted",
                        root_thread_id: "native",
                        actor_project_id: projectId,
                        library_id: "library",
                        store_epoch: "epoch",
                        scope: frozenMode === "full-access" ? "library" : "project",
                        source:
                          frozenMode === "full-access" ? "builtin_full_access" : "project_turn",
                      }
                    : null,
                },
              },
            }),
        },
      } as never),
    ),
  };
};

it.effect(
  "native admission uses the latest Core Project permission selection and immutable exact Turn authority",
  () =>
    Effect.gen(function* () {
      for (const mode of ["auto", "full-access"] as const) {
        const fixture = setup("project", mode);
        const owner = yield* fixture.owner;
        const input = {
          threadId: "native",
          turnId: "accepted",
          projectId: "project",
          readOnly: true,
        };
        const now = Date.now();
        const authority = yield* owner.freeze(input);
        assert.equal(authority?.scope, mode === "full-access" ? "library" : "project");
        assert.isTrue(authority?.readOnly);
        assert.equal(authority?.turnId, "accepted");
        assert.equal((yield* Effect.flip(owner.freeze(input))).operation, "freeze");
        assert.lengthOf(fixture.applies, 1);
        const operationId = fixture.applies[0]!.operationId;
        assert.isTrue(isBoundedOperationId(operationId));
        const issuedAt = Number(operationId.split(":")[2]);
        const expiresAt = Number(operationId.split(":")[3]);
        assert.isAtLeast(issuedAt, now);
        assert.equal(expiresAt - issuedAt, OPERATION_IDENTITY_WINDOW_MS);
        assert.isAbove(expiresAt, Date.now());
        assert.deepNestedInclude(fixture.applies[0], {
          "intent.source": mode === "full-access" ? "builtin_full_access" : "project_turn",
          "intent.read_only": true,
        });
      }
      const projectless = setup(null, "auto");
      const owner = yield* projectless.owner;
      assert.isNull(
        yield* owner.freeze({
          threadId: "native",
          turnId: "accepted",
          projectId: null,
          readOnly: false,
        }),
      );
      assert.lengthOf(projectless.applies, 0);
    }),
);

it.effect("a reassigned Thread cannot obtain authority for its former Project", () =>
  Effect.gen(function* () {
    const fixture = setup("project:new", "full-access");
    const owner = yield* fixture.owner;
    const failure = yield* Effect.flip(
      owner.freeze({
        threadId: "native",
        turnId: "accepted",
        projectId: "project:old",
        readOnly: false,
      }),
    );
    assert.equal(failure.operation, "freeze");
    assert.lengthOf(fixture.applies, 0);
  }),
);

it.effect(
  "an accepted Turn cannot lend its earlier write or Library authority to a new policy",
  () =>
    Effect.gen(function* () {
      const input = {
        threadId: "native",
        turnId: "accepted",
        projectId: "project",
        readOnly: false,
      };
      const project = setup("project", "auto");
      const projectOwner = yield* project.owner;
      yield* projectOwner.freeze(input);
      const planFailure = yield* Effect.flip(projectOwner.freeze({ ...input, readOnly: true }));
      assert.equal(planFailure.operation, "freeze");
      assert.lengthOf(project.applies, 1);

      const library = setup("project", "full-access");
      const libraryOwner = yield* library.owner;
      assert.equal((yield* libraryOwner.freeze(input))?.scope, "library");
      library.setMode("auto");
      const policyFailure = yield* Effect.flip(libraryOwner.freeze(input));
      assert.equal(policyFailure.operation, "freeze");
      assert.lengthOf(library.applies, 1);

      const projectless = setup(null, "full-access");
      const projectlessOwner = yield* projectless.owner;
      const projectlessInput = { ...input, projectId: null };
      assert.equal((yield* projectlessOwner.freeze(projectlessInput))?.scope, "library");
      projectless.setMode("auto");
      assert.isNull(yield* projectlessOwner.freeze(projectlessInput));
      assert.lengthOf(projectless.applies, 1);
    }),
);
