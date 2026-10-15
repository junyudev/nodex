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
import type { NodexAgentDynamicExecutionContext } from "./NodexAgentDynamicExecutionContext";
import { NodexAgentApplication } from "./NodexAgentApplication";
import { executeNodexAgentV3Tool } from "./NodexAgentDynamicExecution";
import {
  buildNodexAgentDynamicToolSpecs,
  layer,
  selectNodexAgentDynamicToolSpecs,
  NodexAgentDynamicTools,
  type NodexAgentDynamicToolCallContext,
} from "./NodexAgentDynamicTools";

it.effect("prepares a Page once and commits through the canonical application", () =>
  Effect.gen(function* () {
    const input = CreatePagesV3InputSchema.parse({
      destination: { kind: "library" },
      pages: [{ title: "Launch", markdown: "## Milestones" }],
    });
    const output = CreatePagesV6OutputSchema.parse({
      data: {
        pages: [
          {
            pageId: "created",
            pageKey: null,
            location: { kind: "library", libraryId: "library" },
            bodyBlocksCreated: 1,
          },
        ],
        created: 1,
      },
    });
    const trace: string[] = [];
    const command = {
      threadId: "thread",
      callId: "call",
      projectId: "project",
      requestHash: "hash",
      mutationId: "mutation",
      storeEpoch: "epoch",
      input,
      destination: { kind: "library" },
      pages: [],
    } as unknown as NodexAgentCreatePagesCommand;
    const unexpected = () => Effect.die("Unexpected operation");
    const app = NodexAgentApplication.of({
      read: unexpected,
      readPageObservation: unexpected,
      completePageUpdate: unexpected,
      prepare: () =>
        Effect.sync(() => {
          trace.push("prepare");
          return {
            kind: "create_pages",
            value: {
              result: {
                ok: true,
                value: { kind: "prepared", command, documentHeads: [], previews: [] },
              },
            },
          } as never;
        }),
      apply: () =>
        Effect.sync(() => {
          trace.push("apply");
          return { kind: "create_pages", value: { ok: true, value: { output } } } as never;
        }),
    });
    const result = yield* executeNodexAgentV3Tool("create_pages", input, {
      threadId: "thread",
      callId: "call",
      operationId: "operation",
      authority: {
        threadId: "thread",
        turnId: "turn",
        rootThreadId: "thread",
        actorProjectId: "project",
        libraryId: "library",
        storeEpoch: "epoch",
        admittedAtMs: 1,
      },
    }).pipe(Effect.provideService(NodexAgentApplication, app));
    assert.deepEqual(result, output);
    assert.deepEqual(trace, ["prepare", "apply"]);
  }),
);

it.effect("publishes and enforces the current Nodex tool catalog at the protocol boundary", () => {
  const application = NodexAgentApplication.of({
    readPageObservation: () => Effect.die("unexpected Page observation"),
    read: () => Effect.die("catalog validation must not enter the application"),
    completePageUpdate: () => Effect.die("catalog validation must not enter the application"),
    prepare: () => Effect.die("catalog validation must not enter the application"),
    apply: () => Effect.die("catalog validation must not enter the application"),
  });
  const policy: NodexAgentDynamicToolCallContext = {
    toolsetRevision: NODEX_APP_TOOLSET_REVISION,
    authority: null,
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
          readPageObservation: () => Effect.die("unexpected Page observation"),
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
