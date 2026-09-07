import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createBoundedOperationId } from "../../shared/operation-identity";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import {
  ProjectWorkspace,
  type ProjectWorkspaceService,
} from "../project-application/ProjectWorkspace";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import {
  ProjectSessionCommands,
  ProjectSessionCommandsError,
} from "../project-application/ProjectSessionCommands";
import { make } from "./WorkspaceAppTools";

const authority: FrozenNodexAgentTurnAuthority = {
  threadId: "thread:a",
  turnId: "turn:a",
  rootThreadId: "thread:a",
  actorProjectId: "project:a",
  libraryId: "library:a",
  storeEpoch: "epoch:a",
  frozenAtMs: Date.now(),
  readOnly: false,
  scope: "project",
  source: "project_turn",
};
const input = (name: string, args: Record<string, unknown>): AppToolInvocation => ({
  name,
  arguments: args,
  caller: {
    threadId: "thread:a",
    turnId: "turn:a",
    callId: "call:a",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
});
const setup = (
  workspace: Partial<ProjectWorkspaceService>,
  readOnly = false,
  sessions: Partial<ProjectSessionCommands["Service"]> = {},
) =>
  make.pipe(
    Effect.provideService(ProjectWorkspace, workspace as ProjectWorkspaceService),
    Effect.provideService(ProjectSessionCommands, sessions as ProjectSessionCommands["Service"]),
    Effect.provideService(CoreAuthority, { identity: { profileId: "profile:a" } } as never),
    Effect.provideService(CodexTurnAuthority, {
      capture: () => Effect.succeed({ ...authority, readOnly }),
    } as never),
  );

it.effect("rejects read-only writes and caller identity arguments before mutation", () =>
  Effect.gen(function* () {
    let calls = 0;
    const workspace = {
      createSidebarSection: () =>
        Effect.sync(() => {
          calls++;
          return {} as never;
        }),
    };
    const readonly = yield* setup(workspace, true);
    assert.deepStrictEqual(
      (yield* readonly(input("create_sidebar_section", { name: "Research" }))).structuredContent,
      { error: { code: "read_only_turn" } },
    );
    const writable = yield* setup(workspace);
    assert.deepStrictEqual(
      (yield* writable(input("create_sidebar_section", { name: "Research", projectId: "other" })))
        .structuredContent,
      { error: { code: "invalid_arguments" } },
    );
    assert.strictEqual(calls, 0);
  }),
);

it.effect("keeps create identity stable for the same native call and carries its provenance", () =>
  Effect.gen(function* () {
    const commands: unknown[] = [];
    const callers: unknown[] = [];
    const execute = yield* setup({
      createSidebarSection: (command) =>
        Effect.gen(function* () {
          commands.push(command);
          callers.push(yield* CoreApplicationAgent);
          return {
            value: { sectionId: command.payload.sectionId, name: command.payload.input.name },
            apply: {},
          } as never;
        }),
    });
    const call = input("create_sidebar_section", { name: "Research" });
    const first = yield* execute(call);
    const second = yield* execute(call);
    assert.strictEqual(first.isError, undefined);
    assert.deepStrictEqual(second, first);
    assert.deepStrictEqual(commands[0], commands[1]);
    assert.deepStrictEqual(callers[0], {
      profile_id: "profile:a",
      authority: {
        thread_id: "thread:a",
        turn_id: "turn:a",
        root_thread_id: "thread:a",
        actor_project_id: "project:a",
        library_id: "library:a",
        store_epoch: "epoch:a",
        scope: "project",
        source: "project_turn",
      },
    });
    assert.strictEqual(yield* CoreApplicationAgent, null);
  }),
);

it.effect(
  "renames through the Session owner with the exact Turn and resolves the calling Session",
  () =>
    Effect.gen(function* () {
      const accepted: unknown[] = [];
      const sessions: Partial<ProjectSessionCommands["Service"]> = {
        rename: (command) =>
          Effect.gen(function* () {
            accepted.push({ command, provenance: yield* CoreApplicationAgent });
            return {
              value: { id: command.payload.sessionId, displayTitle: command.payload.input.title },
              apply: {},
            } as never;
          }),
      };
      const execute = yield* setup(
        { getThread: () => Effect.succeed({ sessionId: "self" } as never) },
        false,
        sessions,
      );
      const own = yield* execute(input("set_session_title", { title: "Renamed" }));
      assert.deepStrictEqual(own.structuredContent, {
        operationId: own.structuredContent?.operationId,
        sessionId: "self",
        title: "Renamed",
        receipt: {},
      });
      const draft = yield* execute(
        input("set_session_title", { sessionId: "threadless", title: "Draft" }),
      );
      assert.strictEqual(draft.structuredContent?.sessionId, "threadless");
      assert.lengthOf(accepted, 2);
      assert.deepNestedInclude(accepted[0], {
        "provenance.authority.thread_id": "thread:a",
        "provenance.authority.turn_id": "turn:a",
        "command.payload.sessionId": "self",
        "command.payload.input.title": "Renamed",
      });
      const readonly = yield* setup({}, true, sessions);
      assert.strictEqual(
        (yield* readonly(input("set_session_title", { sessionId: "threadless", title: "Denied" })))
          .isError,
        true,
      );
      assert.strictEqual(
        (yield* execute(input("set_session_title", { title: "Denied", threadId: "forged" })))
          .isError,
        true,
      );
      assert.lengthOf(accepted, 2);
      assert.strictEqual(yield* CoreApplicationAgent, null);
    }),
);

it.effect(
  "routes canonical pinned sections through pinning and custom sections through placement",
  () =>
    Effect.gen(function* () {
      const pinned: unknown[] = [];
      const moved: unknown[] = [];
      const execute = yield* setup({
        listSidebarSections: () =>
          Effect.succeed({
            items: [
              { sectionId: "canonical-pinned", kind: "pinned" },
              { sectionId: "custom", kind: "custom" },
            ],
            nextCursor: null,
          } as never),
        setProjectSessionPinned: (command) =>
          Effect.sync(() => {
            pinned.push(command.payload);
            return { apply: {} } as never;
          }),
        moveSidebarSectionItem: (command) =>
          Effect.sync(() => {
            moved.push(command.payload);
            return { apply: {} } as never;
          }),
      });
      yield* execute(
        input("move_session_to_sidebar_section", {
          sessionId: "threadless",
          sectionId: "canonical-pinned",
        }),
      );
      yield* execute(
        input("move_session_to_sidebar_section", { sessionId: "threadless", sectionId: "custom" }),
      );
      assert.deepStrictEqual(pinned, [{ sessionId: "threadless", pinned: true }]);
      assert.deepStrictEqual(moved, [
        {
          item: { kind: "session", sessionId: "threadless" },
          sectionId: "custom",
          placement: { kind: "end" },
        },
      ]);
    }),
);

it.effect(
  "routes archive, restore and pin to the Session owner and reports committed failures",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const mutation = (name: string, archived: boolean, pinned: boolean) => () =>
        Effect.sync(() => {
          calls.push(name);
          return { value: { id: "draft", archived, pinned }, apply: {} } as never;
        });
      const execute = yield* setup({}, false, {
        archive: mutation("archive", true, false),
        unarchive: mutation("restore", false, false),
        setPinned: mutation("pin", false, true),
      });
      assert.strictEqual(
        (yield* execute(input("set_session_archived", { sessionId: "draft", archived: true })))
          .structuredContent?.archived,
        true,
      );
      assert.strictEqual(
        (yield* execute(input("set_session_archived", { sessionId: "draft", archived: false })))
          .structuredContent?.archived,
        false,
      );
      assert.strictEqual(
        (yield* execute(input("set_session_pinned", { sessionId: "draft", pinned: true })))
          .structuredContent?.pinned,
        true,
      );
      assert.deepStrictEqual(calls, ["archive", "restore", "pin"]);
      const failed = yield* setup({}, false, {
        archive: () =>
          Effect.fail(
            new ProjectSessionCommandsError({
              operation: "archive-conversation",
              cause: new Error("offline"),
              committedOperationId: "operation:retry",
            }),
          ),
      });
      const result = yield* failed(
        input("set_session_archived", { sessionId: "draft", archived: true }),
      );
      assert.strictEqual(result.isError, true);
      assert.deepStrictEqual(result.structuredContent, {
        error: {
          code: "session_reconciliation_failed",
          details: { operationId: "operation:retry", committed: true },
        },
      });
    }),
);

it.effect(
  "lists complete mixed placements without transcripts and carries observed order into authorized mutation",
  () =>
    Effect.gen(function* () {
      const reads: unknown[] = [];
      const writes: unknown[] = [];
      const workspace: Partial<ProjectWorkspaceService> = {
        listSidebarSectionItems: (sectionId, options) =>
          Effect.sync(() => {
            reads.push({ sectionId, options });
            return {
              items: [
                {
                  placementId: "project:p",
                  revision: 2,
                  rankKey: 0,
                  kind: "project",
                  project: { projectId: "p", name: "Project", lifecycle: "active" },
                },
                {
                  placementId: "session:s",
                  revision: 1,
                  rankKey: 1024,
                  kind: "session",
                  session: {
                    id: "s",
                    displayTitle: "Draft",
                    archived: true,
                    thread: { threadPreview: "Private transcript" },
                  },
                },
              ],
              nextCursor: "next",
              hasMore: true,
              projectionRevision: 9,
            } as never;
          }),
        reorderSidebarSectionItems: (command) =>
          Effect.gen(function* () {
            writes.push({ command, provenance: yield* CoreApplicationAgent });
            return { value: undefined, apply: {} } as never;
          }),
      };
      const readonly = yield* setup(workspace, true);
      const listed = yield* readonly(
        input("list_sidebar_section_items", { sectionId: "mixed", first: 2 }),
      );
      assert.deepEqual(listed.structuredContent, {
        items: [
          {
            placementId: "project:p",
            revision: 2,
            rankKey: 0,
            kind: "project",
            projectId: "p",
            title: "Project",
            archived: false,
          },
          {
            placementId: "session:s",
            revision: 1,
            rankKey: 1024,
            kind: "session",
            sessionId: "s",
            title: "Draft",
            archived: true,
          },
        ],
        nextCursor: "next",
        hasMore: true,
        projectionRevision: 9,
      });
      assert.deepEqual(reads, [
        { sectionId: "mixed", options: { first: 2, includeArchived: true } },
      ]);
      const args = {
        sectionId: "mixed",
        items: [
          { placementId: "session:s", expectedRevision: 1, expectedRankKey: 1024 },
          { placementId: "project:p", expectedRevision: 2, expectedRankKey: 0 },
        ],
      };
      assert.isTrue((yield* readonly(input("reorder_section", args))).isError);
      assert.lengthOf(writes, 0);
      const writable = yield* setup(workspace);
      const result = yield* writable(input("reorder_section", args));
      assert.isUndefined(result.isError);
      assert.deepNestedInclude(writes[0], {
        "command.payload": args,
        "provenance.authority.turn_id": "turn:a",
      });
    }),
);

const builtinSection = (kind: "pinned" | "projects" | "chats") => ({
  sectionId: `canonical:${kind}`,
  kind,
  name: null,
  rankKey: 0,
  revision: 1,
  lifecycle: "active" as const,
  directItemCount: 0,
  effectiveSessionCount: 0,
  hasRunning: false,
  hasUnread: false,
});
const builtinSections = () =>
  Effect.succeed({
    items: [builtinSection("pinned"), builtinSection("projects"), builtinSection("chats")],
    nextCursor: null,
    hasMore: false,
    projectionRevision: 1,
  });

it.effect("discovers exact built-in Project and Session lanes through canonical Section IDs", () =>
  Effect.gen(function* () {
    const reads: unknown[] = [];
    const execute = yield* setup(
      {
        listSidebarSections: builtinSections,
        listBuiltinSidebarOrder: (lane, window) =>
          Effect.sync(() => {
            reads.push({ lane, window });
            return {
              items: [{ kind: "session", sessionId: "draft:a", title: "Draft" }],
              orderRevision: "order:a",
              nextCursor: "after:a",
              hasMore: true,
              projectionRevision: 1,
            };
          }),
      },
      true,
    );
    const result = yield* execute(
      input("list_sidebar_order", { sectionId: "canonical:pinned", itemKind: "session", first: 1 }),
    );
    assert.deepStrictEqual(reads, [{ lane: "pinned_sessions", window: { first: 1 } }]);
    assert.deepStrictEqual(result.structuredContent?.items, [
      { kind: "session", sessionId: "draft:a", title: "Draft" },
    ]);
    assert.strictEqual(result.structuredContent?.orderRevision, "order:a");
    for (const sectionId of ["pinned", "canonical:chats"]) {
      assert.strictEqual(
        (yield* execute(input("list_sidebar_order", { sectionId, itemKind: "session" }))).isError,
        true,
      );
    }
    assert.strictEqual(reads.length, 1);
  }),
);

it.effect(
  "preserves Project priority requests and complete Session orders for Core admission",
  () =>
    Effect.gen(function* () {
      const commands: unknown[] = [];
      const callers: unknown[] = [];
      const execute = yield* setup({
        listSidebarSections: builtinSections,
        reorderBuiltinSidebarItems: (command) =>
          Effect.gen(function* () {
            commands.push(command);
            callers.push(yield* CoreApplicationAgent);
            return { value: undefined, apply: {} as never };
          }),
        prioritizeBuiltinSidebarProjects: (command) =>
          Effect.gen(function* () {
            commands.push(command);
            callers.push(yield* CoreApplicationAgent);
            return { value: undefined, apply: {} as never };
          }),
      });
      const operationId = createBoundedOperationId("sidebar.order");
      for (const [name, args, lane, itemIds] of [
        [
          "reorder_section",
          { sectionId: "canonical:pinned", sessionIds: ["draft:a", "acp:b", "attached:c"] },
          "pinned_sessions",
          ["draft:a", "acp:b", "attached:c"],
        ],
        [
          "reorder_sidebar_projects",
          { sectionId: "canonical:projects", projectIds: ["project:b", "project:a"] },
          "projects",
          ["project:b", "project:a"],
        ],
        [
          "reorder_sidebar_projects",
          { sectionId: "canonical:pinned", projectIds: ["project:a"] },
          "pinned_projects",
          ["project:a"],
        ],
      ] as const) {
        const result = yield* execute(
          input(name, { ...args, expectedOrderRevision: "observed:1", operationId }),
        );
        assert.strictEqual(result.isError, undefined);
        assert.deepStrictEqual(commands.at(-1), {
          operationId,
          payload: {
            lane,
            ...(name === "reorder_section" ? { itemIds } : { projectIds: itemIds }),
            expectedOrderRevision: "observed:1",
          },
        });
      }
      assert.strictEqual(callers.length, 3);
      assert.strictEqual(
        (yield* execute(
          input("reorder_section", {
            sectionId: "canonical:pinned",
            sessionIds: [],
            items: [],
            expectedOrderRevision: "observed:1",
          }),
        )).isError,
        true,
      );
      assert.strictEqual(commands.length, 3);
    }),
);

it.effect("withdraws a built-in reorder if its caller ends during Section discovery", () =>
  Effect.gen(function* () {
    let active = true;
    let writes = 0;
    const execute = yield* setup({
      listSidebarSections: () =>
        Effect.gen(function* () {
          active = false;
          return yield* builtinSections();
        }),
      reorderBuiltinSidebarItems: () =>
        Effect.sync(() => {
          writes++;
          return {} as never;
        }),
    });
    const invocation = input("reorder_section", {
      sectionId: "canonical:pinned",
      sessionIds: ["draft:a"],
      expectedOrderRevision: "observed:1",
    });
    const result = yield* execute({
      ...invocation,
      caller: { ...invocation.caller, isActive: () => active },
    });
    assert.deepStrictEqual(result.structuredContent, { error: { code: "call_withdrawn" } });
    assert.strictEqual(writes, 0);
  }),
);
