import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CreatePagesV3InputSchema,
  CreatePagesV6OutputSchema,
  NODEX_APP_TOOLSET_REVISION,
  type NodexAgentCreatePagesCommand,
} from "../../shared/nodex-agent-tools";
import type { NodexAgentDynamicExecutionContext } from "./NodexAgentDynamicPolicy";
import { NodexAgentApplication } from "./NodexAgentApplication";
import { executeNodexAgentV3Tool } from "./NodexAgentDynamicExecution";
import {
  buildNodexAgentDynamicToolSpecs,
  layer,
  selectNodexAgentDynamicToolSpecs,
  NodexAgentDynamicTools,
  type NodexAgentDynamicToolCallContext,
} from "./NodexAgentDynamicTools";

it.effect("authorizes a prepared Page creation before the canonical application commit", () =>
  Effect.gen(function* () {
    const input = CreatePagesV3InputSchema.parse({
      destination: { kind: "library" },
      pages: [{ title: "**Launch** plan", markdown: "## Milestones\n\n- [ ] Ship" }],
    });
    const output = CreatePagesV6OutputSchema.parse({
      data: {
        pages: [
          {
            pageId: "page-created",
            pageKey: null,
            location: { kind: "library", libraryId: "library:agent" },
            bodyBlocksCreated: 2,
          },
        ],
        created: 1,
      },
    });
    const command = {
      threadId: "thread:agent",
      callId: "call:agent",
      projectId: "project:agent",
      requestHash: "request:agent",
      mutationId: "mutation:agent",
      storeEpoch: "epoch:agent",
      input,
      destination: { kind: "library" },
      pages: [],
    } as unknown as NodexAgentCreatePagesCommand;
    const trace: string[] = [];
    let preparationCount = 0;
    const application = NodexAgentApplication.of({
      read: () => Effect.die("unexpected read"),
      completePageUpdate: () => Effect.die("unexpected completion"),
      prepare: (preparation) =>
        Effect.sync(() => {
          assert.strictEqual(preparation.kind, "create_pages");
          preparationCount += 1;
          trace.push("prepare");
          const resourceAccess = preparation.request.resourceAccess;
          return {
            kind: "create_pages" as const,
            value: {
              result: {
                ok: true as const,
                value: {
                  kind: "prepared" as const,
                  command: { ...command, ...(resourceAccess ? { resourceAccess } : {}) },
                  documentHeads: [],
                  previews: [
                    {
                      pageId: "page-created",
                      title: "Launch plan",
                      bodyBlockCount: 2,
                      targetMarkdown: "## Milestones\n\n- [ ] Ship",
                    },
                  ],
                },
              },
              events: [],
              metrics: {
                mutationId: command.mutationId,
                queueWaitMs: 0,
                workerDurationMs: 0,
                transactionMs: 0,
                eventCount: 0,
              },
            },
          };
        }),
      apply: (applicationCommand) =>
        Effect.sync(() => {
          assert.strictEqual(applicationCommand.kind, "create_pages");
          trace.push("apply");
          return {
            kind: "create_pages" as const,
            value: {
              ok: true as const,
              value: {
                output,
                duplicate: false,
                documentCommits: [],
                affectedDatabaseBlockIds: [],
                commitSeq: 1,
              },
            },
          };
        }),
    });
    const authority = {
      threadId: "thread:agent",
      turnId: "turn:agent",
      rootThreadId: "thread:agent",
      actorProjectId: "project:agent",
      libraryId: "library:agent",
      storeEpoch: "epoch:agent",
      frozenAtMs: 1_785_491_085_000,
      scope: "project" as const,
      source: "project_turn" as const,
    };
    const taskGrants: string[] = [];
    const context: NodexAgentDynamicExecutionContext = {
      operationId: "nodexop:v1:1785491085000:1786095885000:test:operation",
      threadId: authority.threadId,
      callId: "call:agent",
      authority,
      access: {
        read: "allowed",
        write: "consent_required",
        domains: ["document", "placement", "database"],
      },
      resolveResourceAccess: (intents) =>
        Effect.succeed({
          kind: "consent_required" as const,
          requirements: [
            {
              intent: intents[0]!,
              grant: {
                root: { kind: "library" as const, libraryId: authority.libraryId },
                access: "read_write" as const,
                libraryActions: ["create_child" as const],
              },
              reason: "library_consent_required" as const,
              persistable: false,
            },
          ],
          inspectionAccess: {
            kind: "inspection" as const,
            scope: "call" as const,
            threadId: authority.threadId,
            turnId: authority.turnId,
            callId: "call:agent",
            rootThreadId: authority.rootThreadId,
            actorProjectId: authority.actorProjectId,
            libraryId: authority.libraryId,
            storeEpoch: authority.storeEpoch,
            grants: [],
          },
        }),
      authorize: (request) =>
        Effect.sync(() => {
          trace.push("authorize");
          assert.strictEqual(request.tool, "create_pages");
          assert.isTrue(request.preview.markdownPreview?.includes("Milestones"));
          return {
            decision: "allow_task" as const,
            resourceAccess: {
              kind: "consent" as const,
              scope: "task" as const,
              rootThreadId: authority.rootThreadId,
              actorProjectId: authority.actorProjectId,
              libraryId: authority.libraryId,
              storeEpoch: authority.storeEpoch,
              grants: request.requirements.map(({ grant }) => grant),
            },
          };
        }),
      recordTaskResourceAccess: (grants) =>
        Effect.sync(() => {
          taskGrants.push(...grants.map(({ root }) => (root.kind === "page" ? root.pageId : "")));
        }),
    };

    const result = yield* executeNodexAgentV3Tool("create_pages", input, context).pipe(
      Effect.provideService(NodexAgentApplication, application),
    );

    assert.deepEqual(result, output);
    assert.deepEqual(trace, ["prepare", "authorize", "prepare", "apply"]);
    assert.strictEqual(preparationCount, 2);
    assert.deepEqual(taskGrants, ["page-created"]);
  }),
);

it.effect("publishes and enforces the current Nodex tool catalog at the protocol boundary", () => {
  const application = NodexAgentApplication.of({
    read: () => Effect.die("catalog validation must not enter the application"),
    completePageUpdate: () => Effect.die("catalog validation must not enter the application"),
    prepare: () => Effect.die("catalog validation must not enter the application"),
    apply: () => Effect.die("catalog validation must not enter the application"),
  });
  const policy: NodexAgentDynamicToolCallContext = {
    toolsetRevision: NODEX_APP_TOOLSET_REVISION,
    authority: null,
    access: {
      read: "allowed",
      write: "consent_required",
      domains: ["document", "placement", "database"],
    },
    resolveResourceAccess: () => Effect.succeed({ kind: "authorized" as const }),
    authorize: () => Effect.succeed("deny" as const),
  };
  const parseFailure = (response: {
    readonly contentItems: readonly { readonly type: string; readonly text?: string }[];
  }) => {
    const item = response.contentItems[0];
    return JSON.parse(item?.type === "inputText" ? (item.text ?? "null") : "null") as {
      readonly error?: {
        readonly code?: string;
        readonly message?: string;
        readonly recovery?: string;
        readonly retryable?: boolean;
      };
    };
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const [catalog] = buildNodexAgentDynamicToolSpecs();
      assert.strictEqual(catalog?.type, "namespace");
      if (!catalog || catalog.type !== "namespace") return;
      assert.deepEqual(
        catalog.tools.map((tool) => tool.name),
        [
          "advanced_update_page",
          "create_pages",
          "duplicate_page",
          "fetch",
          "get_context",
          "move_pages",
          "query_data_source",
          "query_database_view",
          "search",
          "update_page",
        ],
      );

      const context = yield* Layer.build(
        layer(true).pipe(Layer.provide(Layer.succeed(NodexAgentApplication, application))),
      );
      const tools = Context.get(context, NodexAgentDynamicTools);
      const stale = yield* tools.execute(
        {
          threadId: "thread:stale",
          turnId: "turn:stale",
          callId: "call:stale",
          namespace: "nodex_app",
          tool: "get_context",
          arguments: {},
        },
        { ...policy, toolsetRevision: null },
      );
      assert.isFalse(stale.success);
      assert.deepEqual(parseFailure(stale).error, {
        code: "tool_catalog_stale",
        message: "This task was not launched with the Nodex agent-tool catalog",
        retryable: false,
        recovery: "start_new_task",
      });

      const invalid = yield* tools.execute(
        {
          threadId: "thread:current",
          turnId: "turn:current",
          callId: "call:invalid",
          namespace: "nodex_app",
          tool: "fetch",
          arguments: {},
        },
        policy,
      );
      assert.isFalse(invalid.success);
      assert.strictEqual(parseFailure(invalid).error?.code, "invalid_arguments");
    }),
  );
});

it.effect(
  "rejects restored catalog calls while disabled before reading or authorizing content",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const unexpected = () =>
          Effect.die("disabled tools must not touch application or authorization");
        const application = NodexAgentApplication.of({
          read: unexpected,
          prepare: unexpected,
          apply: unexpected,
          completePageUpdate: unexpected,
        });
        const context = yield* Layer.build(
          layer(false).pipe(Layer.provide(Layer.succeed(NodexAgentApplication, application))),
        );
        const tools = Context.get(context, NodexAgentDynamicTools);
        assert.deepEqual(selectNodexAgentDynamicToolSpecs(false), []);
        assert.deepEqual(selectNodexAgentDynamicToolSpecs(true), buildNodexAgentDynamicToolSpecs());
        const result = yield* tools.execute(
          {
            threadId: "historical",
            turnId: "turn",
            callId: "call",
            namespace: "nodex_app",
            tool: "create_pages",
            arguments: {},
          },
          {
            toolsetRevision: NODEX_APP_TOOLSET_REVISION,
            authority: null,
            access: { read: "allowed", write: "granted", domains: ["document"] },
            resolveResourceAccess: unexpected,
            authorize: unexpected,
          },
        );
        assert.isFalse(result.success);
        const content = result.contentItems[0];
        assert.strictEqual(content?.type, "inputText");
        if (content?.type !== "inputText") return;
        assert.deepEqual(JSON.parse(content.text), {
          error: {
            code: "tool_catalog_stale",
            message: "Nodex dynamic tools are disabled in this instance.",
            retryable: false,
            recovery: "none",
            details: { domainCode: "NODEX_DYNAMIC_TOOLS_DISABLED" },
          },
        });
      }),
    ),
);
