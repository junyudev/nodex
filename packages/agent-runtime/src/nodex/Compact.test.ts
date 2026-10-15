import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { compactThread } from "./Compact.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Native delivery is exercised by RunExecutionService tests."),
};

it.effect(
  "admits one maintenance Run per compact request and refuses reuse on another Thread",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const firstId = ThreadId.make("thread:compact:first");
      const secondId = ThreadId.make("thread:compact:second");
      for (const threadId of [firstId, secondId])
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId: ProjectId.make("project:compact"),
          title: "Compact",
          modelSelection: { instanceId, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      yield* Effect.gen(function* () {
        const request = { threadId: firstId, requestId: CommandId.make("compact-request") };
        const receipt = yield* compactThread(request);
        const retry = yield* compactThread(request);
        expect(retry).toEqual(receipt);
        const projection = yield* orchestrator.getThreadRecords(firstId, ["runs", "messages"]);
        expect(projection.runs).toHaveLength(1);
        expect(projection.runs[0]!.id).toBe(receipt.runId);
        expect(projection.messages[0]).toMatchObject({
          id: receipt.messageId,
          text: "/compact",
          attachments: [],
        });
        expect(
          (yield* compactThread({ ...request, threadId: secondId }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* orchestrator.getThreadRecords(secondId, ["runs"])).runs).toHaveLength(0);
      }).pipe(
        Effect.provide(Layer.mock(ThreadManagementService)({ dispatch: orchestrator.dispatch })),
      );
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "compact-public-maintenance" },
          ProviderAdapterRegistry.layerSingle(adapter),
          { runEffectWorker: false },
        ),
      ),
    ),
);
