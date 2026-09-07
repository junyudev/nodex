import type { components } from "@nodex/core-protocol";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { NodexAgentResourceAccessOverlay } from "../../shared/nodex-agent-resource-access";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { make, type WorkbenchContentSurface } from "./WorkbenchContentAccess";

const authority: FrozenNodexAgentTurnAuthority = {
  threadId: "thread:actor",
  turnId: "turn:actor",
  rootThreadId: "thread:actor",
  actorProjectId: "project:actor",
  libraryId: "library:current",
  storeEpoch: "epoch:current",
  frozenAtMs: 1,
  readOnly: true,
  scope: "project",
  source: "project_turn",
};
const page: WorkbenchContentSurface = {
  id: "surface:page",
  titleSnapshot: "Stale renderer title",
  kind: "page_stage",
  config: {
    accessContext: { kind: "library" },
    pageId: "page:target",
    titleSnapshot: "Stale renderer title",
  },
};
const setup = (read: CoreModules["Service"]["library"]["read"]) =>
  make.pipe(
    Effect.provideService(CoreModules, CoreModules.of({ library: { read } } as never)),
    Effect.provideService(CoreAuthority, { identity: { profileId: "profile:current" } } as never),
  );

it.effect(
  "binds semantic defaults to the frozen actor and preserves task access independently of display context",
  () =>
    Effect.gen(function* () {
      const taskAccess: NodexAgentResourceAccessOverlay = {
        kind: "consent",
        scope: "task",
        rootThreadId: "thread:actor",
        actorProjectId: "project:actor",
        libraryId: "library:current",
        storeEpoch: "epoch:current",
        grants: [{ root: { kind: "database", databaseId: "database:target" }, access: "read" }],
      };
      const requests: unknown[] = [];
      const service = yield* setup((read, options, projectId) => {
        requests.push({ read, options, projectId });
        return Effect.succeed({
          value: {
            kind: "agent_surface_description",
            value: {
              status: "authorized",
              kind: "database_view",
              title: "Canonical list",
              library_id: "library:current",
              displayed_access_context: { kind: "project", projectId: "project:displayed" },
              database_id: "database:target",
              data_source_id: "source:target",
              view_id: "view:resolved",
              layout: "list",
            },
          },
        } as never);
      });
      const result = yield* service.describe({
        authority,
        callId: "call:exact",
        taskAccess,
        surface: {
          id: "surface:database",
          titleSnapshot: "Stale renderer database",
          kind: "db_view",
          config: {
            accessContext: { kind: "project", projectId: "project:displayed" },
            target: { kind: "project-default" },
          },
        },
      });
      assert.deepEqual(result, {
        status: "authorized",
        kind: "database_view",
        title: "Canonical list",
        libraryId: "library:current",
        displayedAccessContext: { kind: "project", projectId: "project:displayed" },
        databaseId: "database:target",
        dataSourceId: "source:target",
        viewId: "view:resolved",
        layout: "list",
      });
      assert.deepEqual(requests, [
        {
          projectId: "project:actor",
          options: { deadlineMs: 5_000 },
          read: {
            kind: "agent_surface_description",
            displayed_access_context: { kind: "project", projectId: "project:displayed" },
            target: { kind: "database_view", target: { kind: "project_default" } },
            authorization: {
              call_id: "call:exact",
              provenance: {
                profile_id: "profile:current",
                authority: {
                  thread_id: "thread:actor",
                  turn_id: "turn:actor",
                  root_thread_id: "thread:actor",
                  actor_project_id: "project:actor",
                  library_id: "library:current",
                  store_epoch: "epoch:current",
                  scope: "project",
                  source: "project_turn",
                },
              },
              resource_access: {
                kind: "consent",
                scope: "task",
                root_thread_id: "thread:actor",
                actor_project_id: "project:actor",
                library_id: "library:current",
                store_epoch: "epoch:current",
                grants: [
                  { root: { kind: "database", database_id: "database:target" }, access: "read" },
                ],
              },
            },
          },
        },
      ]);
    }),
);

it.effect.each(["consent_required", "access_denied", "unavailable"] as const)(
  "keeps restricted %s descriptions free of renderer identities and titles",
  (reason) =>
    Effect.gen(function* () {
      const service = yield* setup(() =>
        Effect.succeed({
          value: {
            kind: "agent_surface_description",
            value: { status: "restricted", reason },
          },
        } as never),
      );
      assert.deepEqual(
        yield* service.describe({ authority, callId: "call:exact", surface: page }),
        {
          status: "restricted",
          reason,
        },
      );
    }),
);

it.effect(
  "returns current canonical titles and fails closed when Core cannot describe the target",
  () =>
    Effect.gen(function* () {
      const value: components["schemas"]["LibraryAgentSurfaceDescription"] = {
        status: "authorized",
        kind: "page",
        page_id: "page:target",
        title: "Current Core title",
        library_id: "library:current",
        displayed_access_context: { kind: "library" },
      };
      const service = yield* setup(() =>
        Effect.succeed({ value: { kind: "agent_surface_description", value } } as never),
      );
      assert.deepEqual(
        yield* service.describe({ authority, callId: "call:exact", surface: page }),
        {
          status: "authorized",
          kind: "page",
          pageId: "page:target",
          title: "Current Core title",
          libraryId: "library:current",
          displayedAccessContext: { kind: "library" },
        },
      );
      const unavailable = yield* setup(() =>
        Effect.fail(
          coreRuntimeError({
            operation: "library.read",
            reason: "transport-loss",
            retryable: true,
          }),
        ),
      );
      assert.deepEqual(
        yield* unavailable.describe({ authority, callId: "call:exact", surface: page }),
        {
          status: "restricted",
          reason: "unavailable",
        },
      );
    }),
);
