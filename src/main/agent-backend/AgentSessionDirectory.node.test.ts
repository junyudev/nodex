import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { AgentBackendSessionChangedEvent } from "../../shared/agent-backend-api";
import type { AgentSessionHandle } from "./AgentSessionHandle";
import {
  AcpBackendSessionManager,
  type AcpBackendSessionHandle,
} from "./acp/AcpBackendSessionManager";
import { ClaudeSessionManager } from "./claude/ClaudeSessionManager";
import { make } from "./AgentSessionDirectory";

const fixture = () => {
  const calls: string[] = [];
  let nativeId = "native-session";
  let acpId = "acp-session";
  const native = {
    threadId: "native",
    get sessionId() {
      return nativeId;
    },
  } as AgentSessionHandle;
  const prompts: unknown[] = [];
  const acp = {
    threadId: "acp",
    get sessionId() {
      return acpId;
    },
    modes: null,
    configOptions: [],
    prompt: (content: unknown, options: unknown) =>
      Effect.sync(() => {
        prompts.push({ content, options });
        return { stopReason: "end_turn" };
      }),
    setConfigOption: () => Effect.succeed([]),
  } as unknown as AcpBackendSessionHandle;
  const controls = (family: string) => ({
    observe: (threadId: string) =>
      Effect.sync(() => {
        calls.push(`${family}:observe:${threadId}`);
      }),
    unobserve: (threadId: string) =>
      Effect.sync(() => {
        calls.push(`${family}:unobserve:${threadId}`);
      }),
    close: (threadId: string) =>
      Effect.sync(() => {
        calls.push(`${family}:close:${threadId}`);
      }),
    changes: Stream.succeed({ threadId: family } as AgentBackendSessionChangedEvent),
  });
  return {
    native,
    acp,
    prompts,
    calls,
    setIds: () => {
      nativeId = "native-reset";
      acpId = "acp-authenticated";
    },
    owner: make.pipe(
      Effect.provideService(ClaudeSessionManager, {
        ...controls("native"),
        get: (id: string) => Effect.succeed(id === "native" ? native : null),
      } as never),
      Effect.provideService(AcpBackendSessionManager, {
        ...controls("acp"),
        get: (id: string) => Effect.succeed(id === "acp" ? acp : null),
      } as never),
    ),
  };
};

it.effect("native and ACP handles retain one live identity through the shared directory", () =>
  Effect.gen(function* () {
    const f = fixture();
    const directory = yield* f.owner;
    assert.strictEqual(yield* directory.get("native"), f.native);
    const acp = directory.adaptAcp(f.acp);
    assert.strictEqual(yield* directory.get("acp"), acp);
    assert.strictEqual(yield* directory.get("acp"), acp);
    assert.isNull(yield* directory.get("missing"));
    f.setIds();
    assert.equal((yield* directory.get("native"))?.sessionId, "native-reset");
    assert.equal(acp.sessionId, "acp-authenticated");
    assert.isUndefined(f.native.authenticate);
    yield* acp.prompt("Hello", { clientUserMessageId: "accepted" });
    assert.deepEqual(f.prompts, [
      { content: [{ type: "text", text: "Hello" }], options: { clientUserMessageId: "accepted" } },
    ]);
  }),
);

it.effect("observation and close reach both scoped families and both publish shared events", () =>
  Effect.gen(function* () {
    const f = fixture();
    const directory = yield* f.owner;
    yield* directory.observe("thread");
    yield* directory.unobserve("thread");
    yield* directory.close("thread");
    assert.deepEqual(f.calls, [
      "native:observe:thread",
      "acp:observe:thread",
      "native:unobserve:thread",
      "acp:unobserve:thread",
      "native:close:thread",
      "acp:close:thread",
    ]);
    const events = yield* Stream.runCollect(directory.changes);
    assert.deepEqual(events.map((event) => event.threadId).sort(), ["acp", "native"]);
  }),
);
