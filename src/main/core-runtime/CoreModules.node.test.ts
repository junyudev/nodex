import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import type {
  AutomationApplyInput,
  AutomationApplyResult,
  AutomationRead,
  AutomationReadSnapshot,
  LibraryApplyResult,
  LibraryReadSnapshot,
  QueryReadSnapshot,
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceApplyResult,
} from "../core-client/types";
import { CoreSessionAccess } from "./CoreAuthority";
import { CoreModules, live } from "./CoreModules";
import { CoreApplicationAgent } from "./CoreApplicationAgent";

const provenance = {
  profile_id: "profile:a",
  authority: {
    thread_id: "thread:a",
    turn_id: "turn:a",
    root_thread_id: "thread:a",
    actor_project_id: "project:actor",
    library_id: "library:a",
    store_epoch: "epoch:a",
    scope: "project",
    source: "project_turn",
  },
} as const;

it.effect("forwards content and Automation project scope to the Core authority", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const projectScopes: Array<{
        readonly operation: string;
        readonly projectId?: string | null;
      }> = [];
      const client = {
        queryRead: () => Promise.resolve({} as QueryReadSnapshot),
        libraryRead: () => Promise.resolve({} as LibraryReadSnapshot),
        libraryApply: () => Promise.resolve({} as LibraryApplyResult),
        automationRead: () => Promise.resolve({} as AutomationReadSnapshot),
        automationApply: () => Promise.resolve({} as AutomationApplyResult),
      } as unknown as CoreGenerationClient;
      const access = CoreSessionAccess.of({
        use: (operation, run, options) =>
          Effect.promise((signal) => {
            projectScopes.push({ operation, projectId: options?.projectId });
            return run(client, signal);
          }),
        handshake: Effect.die("unused"),
      });
      const context = yield* Layer.build(
        live.pipe(Layer.provide(Layer.succeed(CoreSessionAccess, access))),
      );
      const core = Context.get(context, CoreModules);

      yield* core.query.read({} as never, "project:query");
      yield* core.library.read({} as never, undefined, "project:a");
      yield* core.library.apply({} as never, "project:a");
      yield* core.automation.read({} as never, undefined, "project:b");
      yield* core.automation.apply({} as never, undefined, "project:b");

      assert.deepStrictEqual(projectScopes, [
        { operation: "query.read", projectId: "project:query" },
        { operation: "library.read", projectId: "project:a" },
        { operation: "library.apply", projectId: "project:a" },
        { operation: "automation.read", projectId: "project:b" },
        { operation: "automation.apply", projectId: "project:b" },
      ]);
    }),
  ),
);

it.effect(
  "retains Agent provenance through Workspace owners without leaking into host commands",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: Array<{ input: ProjectWorkspaceApplyInput; projectId?: string | null }> =
          [];
        let projectId: string | null | undefined;
        const client = {
          workspaceApply: (input: ProjectWorkspaceApplyInput) => {
            requests.push({ input, projectId });
            return Promise.resolve({} as ProjectWorkspaceApplyResult);
          },
        } as unknown as CoreGenerationClient;
        const access = CoreSessionAccess.of({
          use: (_operation, run, options) =>
            Effect.promise((signal) => {
              projectId = options?.projectId;
              return run(client, signal);
            }),
          handshake: Effect.die("unused"),
        });
        const context = yield* Layer.build(
          live.pipe(Layer.provide(Layer.succeed(CoreSessionAccess, access))),
        );
        const core = Context.get(context, CoreModules);
        const input: ProjectWorkspaceApplyInput = {
          operationId: "operation:a",
          intent: {
            kind: "rename_sidebar_section",
            section_id: "section:a",
            name: "Research",
            expected_revision: 1,
          },
        };
        yield* core.workspace
          .apply(input, undefined, "project:target")
          .pipe(Effect.provideService(CoreApplicationAgent, provenance));
        yield* core.workspace.apply(input, undefined, "project:host");
        assert.deepStrictEqual(requests, [
          {
            projectId: "project:actor",
            input: {
              ...input,
              intent: { kind: "agent_command", provenance, intent: input.intent },
            },
          },
          { projectId: "project:host", input },
        ]);
      }),
    ),
);

it.effect("binds Agent Automation reads and commands without leaking authority to Host calls", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: Array<{
        readonly input: AutomationRead | AutomationApplyInput;
        readonly projectId: string | null | undefined;
      }> = [];
      let projectId: string | null | undefined;
      let admissions = 0;
      const client = {
        automationRead: (input: AutomationRead) => {
          requests.push({ input, projectId });
          return Promise.resolve({} as AutomationReadSnapshot);
        },
        automationApply: (input: AutomationApplyInput) => {
          requests.push({ input, projectId });
          return Promise.resolve({} as AutomationApplyResult);
        },
      } as unknown as CoreGenerationClient;
      const access = CoreSessionAccess.of({
        use: (_operation, run, options) =>
          Effect.promise((signal) => {
            admissions += 1;
            projectId = options?.projectId;
            return run(client, signal);
          }),
        handshake: Effect.die("unused"),
      });
      const context = yield* Layer.build(
        live.pipe(Layer.provide(Layer.succeed(CoreSessionAccess, access))),
      );
      const core = Context.get(context, CoreModules);
      const read: AutomationRead = { kind: "definition", automation_id: "automation:a" };
      const list = {
        kind: "definitions",
        include_deleted: false,
        search_query: "daily",
        window: { after: "cursor:next", first: 25 },
      } as const;
      const input: AutomationApplyInput = {
        operationId: "operation:delete",
        intent: {
          kind: "delete_definition",
          automation_id: "automation:a",
          expected_revision: 4,
        },
      };

      const rejected = yield* core.automation
        .read({ kind: "due_work", lane: "definitions" }, undefined, "project:target")
        .pipe(Effect.provideService(CoreApplicationAgent, provenance), Effect.flip);
      assert.strictEqual(rejected.operation, "automation.read");
      assert.isFalse(rejected.retryable);
      assert.strictEqual(admissions, 0);
      assert.deepStrictEqual(requests, []);

      yield* core.automation
        .read(read, undefined, "project:target")
        .pipe(Effect.provideService(CoreApplicationAgent, provenance));
      yield* core.automation
        .read(list, undefined, "project:target")
        .pipe(Effect.provideService(CoreApplicationAgent, provenance));
      yield* core.automation
        .apply(input, undefined, "project:target")
        .pipe(Effect.provideService(CoreApplicationAgent, provenance));
      yield* core.automation.read(read, undefined, "project:host");
      yield* core.automation.read(list, undefined, "project:host");
      yield* core.automation.apply(input, undefined, "project:host");

      assert.deepStrictEqual(requests, [
        {
          projectId: "project:actor",
          input: { kind: "agent_definition", automation_id: "automation:a", provenance },
        },
        {
          projectId: "project:actor",
          input: {
            kind: "agent_definitions",
            search_query: "daily",
            window: { after: "cursor:next", first: 25 },
            provenance,
          },
        },
        {
          projectId: "project:actor",
          input: {
            ...input,
            intent: { kind: "agent_command", provenance, intent: input.intent },
          },
        },
        { projectId: "project:host", input: read },
        { projectId: "project:host", input: list },
        { projectId: "project:host", input },
      ]);
    }),
  ),
);
