import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { ThreadStartResponse } from "@nodex/codex-app-server-protocol/v2";
import type { CodexThreadStartForSessionInput, CodexThreadStartForSessionResult } from "../../shared/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { createCodexAppServerCapabilitySnapshot } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexRendererRequestOrigin } from "../codex-runtime/CodexRendererRequestOrigin";
import { CodexSessionThreadLaunch, type CodexSessionThreadLaunchContext } from "./CodexSessionThreadLaunch";
import { CodexTurnPresentation } from "./CodexTurnPresentation";
import { make } from "./CodexRendererSessionLaunch";

const input = { sessionId: "session", projectId: "project", prompt: "Hello" } as CodexThreadStartForSessionInput;
const context = { ownerClientId: "window-peer", browserViewScopeId: "window", presentationClaim: { ticketId: "ticket", submissionId: "submission" } };
const origin = { requestId: "native-request", method: "thread/start", conversationId: "", timeoutMs: 0, expiresAtMs: null };
const nativeResponse = { thread: { id: "thread" } } as ThreadStartResponse;
const harness = () => {
  const events: string[] = [];
  const runtime = make.pipe(
    Effect.provideService(CodexSessionThreadLaunch, CodexSessionThreadLaunch.of({ start: (_input, scope: CodexSessionThreadLaunchContext) => Effect.gen(function* () {
      events.push("prepared");
      const response = yield* scope.sendNativeStart!({ cwd: "/workspace" }, createCodexAppServerCapabilitySnapshot({ hostId: "local", generation: 3, userAgent: "codex-app-server/0.0.0" }));
      events.push(`accepted:${response.thread.id}`);
      return { kind: "started", detail: { threadId: response.thread.id } } as CodexThreadStartForSessionResult;
    }) })),
    Effect.provideService(CodexGateway, CodexGateway.of({ requestOnHost: () => Effect.gen(function* () {
      const caller = yield* CodexRendererRequestOrigin;
      assert.strictEqual(caller?.requestId, "native-request");
      events.push("native");
      return nativeResponse;
    }) } as unknown as CodexGateway["Service"])),
    Effect.provideService(CodexTurnPresentation, CodexTurnPresentation.of({ releaseClaim: () => { events.push("released"); } } as never)),
  );
  return { runtime, events };
};

it.effect("returns native response before durable acceptance under the caller identity", () => Effect.gen(function* () {
  const h = harness();
  const service = yield* h.runtime;
  const prepared = yield* service.prepare(input, context);
  assert.deepEqual(prepared.request, { cwd: "/workspace" });
  assert.deepEqual(h.events, ["prepared"]);
  assert.strictEqual(yield* service.execute(prepared.receiptId, context.ownerClientId, origin), nativeResponse);
  assert.deepEqual(h.events, ["prepared", "native"]);
  assert.isTrue(Exit.isFailure(yield* Effect.exit(service.execute(prepared.receiptId, context.ownerClientId, origin))));
  yield* service.accept(prepared.receiptId, context.ownerClientId);
  assert.deepEqual(h.events, ["prepared", "native", "accepted:thread"]);
}));

it.effect("window retirement cancels suspended acceptance and releases the origin claim", () => Effect.gen(function* () {
  const h = harness();
  const service = yield* h.runtime;
  const prepared = yield* service.prepare(input, context);
  yield* service.release(prepared.receiptId);
  assert.deepEqual(h.events, ["prepared", "released"]);
  assert.isTrue(Exit.isFailure(yield* Effect.exit(service.execute(prepared.receiptId, context.ownerClientId, origin))));
}));
