import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { buildAutomationHeartbeatPrompt } from "../../shared/automation-heartbeat";
import type { ConversationIdentity } from "../../shared/conversation-identity";
import type { CodexExecutionHostSettings, CodexThreadSummary } from "../../shared/types";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { nativeConversationIdentity } from "../codex-application/CodexConversationIdentity";
import {
  CodexThreadDirectory,
  CodexThreadDirectoryError,
  type CodexThreadDirectoryEntry,
} from "../codex-application/CodexThreadDirectory";
import { ApplicationSettings, ApplicationSettingsError } from "../settings/ApplicationSettings";
import { makeTestApplicationSettings } from "../settings/ApplicationSettings.test-support";
import { ConversationIdentityError, make } from "./ConversationIdentityQuery";

const nativeThreadId = "019a0000-0000-7000-8000-000000000001";
const runtimeRoot = "nodex:thread:root";
const rootSessionId = "session:root";

const summary = (overrides: Partial<CodexThreadSummary> = {}): CodexThreadSummary => ({
  threadId: nativeThreadId,
  projectId: "project",
  sessionId: "session:native",
  threadName: "Release notes",
  threadPreview: "Draft the notes",
  cwd: null,
  source: null,
  statusType: "idle",
  statusActiveFlags: [],
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  linkedAt: "2026-11-01T00:00:00.000Z",
  executionProfile: { modelId: "gpt-6.1-sol", reasoningEffort: "high", serviceTier: null },
  ...overrides,
});

const runtimeIdentity = (threadId: string): ConversationIdentity => ({
  execution: "agent-runtime",
  threadId,
  sessionId: rootSessionId,
  title: threadId === runtimeRoot ? "Root chat" : "Dependency investigation",
  role: threadId === runtimeRoot ? "chat" : "subagent",
  agent: {
    kind: "claudeAgent",
    providerInstanceId: "instance:claude",
    model: "claude-test",
    effort: "high",
  },
  archived: false,
  host: null,
});

const hosts: CodexExecutionHostSettings = {
  sshHosts: [
    {
      id: "build-box",
      displayName: "Build box",
      kind: "ssh",
      sshAlias: "build",
      port: null,
      managedRoot: "/srv",
      repositoryRoots: [],
      codexBinary: null,
      codexHome: null,
      enabled: true,
    },
  ],
};

type NativeRead = Parameters<CodexThreadDirectory["Service"]["resolve"]>[0];
type Call =
  | { readonly owner: "native"; readonly input: NativeRead }
  | { readonly owner: "runtime"; readonly threadId: string }
  | { readonly owner: "settings" };

const fixture = Effect.fn("ConversationIdentityQuery.testFixture")(function* (
  input: {
    readonly registered?: CodexThreadSummary;
    readonly runtime?: ConversationIdentity | null;
    readonly nativeError?: CodexThreadDirectoryError;
    readonly runtimeError?: AgentRuntimeApplicationError;
    readonly hosts?: CodexExecutionHostSettings;
    readonly settingsError?: ApplicationSettingsError;
  } = {},
) {
  const calls: Call[] = [];
  const baselineSettings = makeTestApplicationSettings();
  const service = yield* make.pipe(
    Effect.provideService(
      CodexThreadDirectory,
      CodexThreadDirectory.of({
        resolve: (request: NativeRead) =>
          Effect.gen(function* () {
            calls.push({ owner: "native", input: request });
            if (input.nativeError) return yield* input.nativeError;
            return input.registered
              ? ({ summary: input.registered } as CodexThreadDirectoryEntry)
              : null;
          }),
      } as CodexThreadDirectory["Service"]),
    ),
    Effect.provideService(
      AgentRuntimeApplication,
      AgentRuntimeApplication.of({
        identify: (threadId: string) =>
          Effect.gen(function* () {
            calls.push({ owner: "runtime", threadId });
            if (input.runtimeError) return yield* input.runtimeError;
            return input.runtime ?? null;
          }),
      } as AgentRuntimeApplication["Service"]),
    ),
    Effect.provideService(
      ApplicationSettings,
      ApplicationSettings.of({
        ...baselineSettings,
        snapshot: () =>
          Effect.gen(function* () {
            calls.push({ owner: "settings" });
            if (input.settingsError) return yield* input.settingsError;
            const snapshot = yield* baselineSettings.snapshot();
            return { ...snapshot, executionHosts: input.hosts ?? { sshHosts: [] } };
          }),
      }),
    ),
  );
  return { service, calls };
});

it.effect.each([
  { label: "root", threadId: runtimeRoot },
  { label: "delegated child", threadId: "thread:task:abcdefghijklmnopqrstuv" },
  {
    label: "Codex provider child",
    threadId: `thread:provider:codex:native-thread:${nativeThreadId}`,
  },
  {
    label: "Claude provider child",
    threadId: "thread:provider:claudeAgent:native-thread:parent%3Atask-1",
  },
  {
    label: "ACP provider child",
    threadId: "thread:provider:acpRegistry:provider-instance:kimi:native-thread:parent%3Atask-1",
  },
])("preserves the Runtime $label identity and its owning Session", ({ threadId }) =>
  Effect.gen(function* () {
    const identity = runtimeIdentity(threadId);
    const { service, calls } = yield* fixture({ runtime: identity });

    assert.strictEqual(yield* service.resolve(threadId), identity);
    assert.strictEqual(identity.sessionId, rootSessionId);
    assert.strictEqual(identity.threadId, threadId);
    assert.deepEqual(calls, [
      { owner: "native", input: { threadId, fidelity: "durable" } },
      { owner: "runtime", threadId },
    ]);
  }),
);

it.effect("uses registered native ownership before Runtime even when the chat has a Session", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* fixture({
      registered: summary(),
      runtime: runtimeIdentity(nativeThreadId),
    });
    const identity = yield* service.resolve(nativeThreadId);

    assert.deepInclude(identity, {
      execution: "native-codex",
      executionHostId: "local",
      threadId: nativeThreadId,
      sessionId: "session:native",
      host: null,
    });
    assert.deepEqual(calls, [
      { owner: "native", input: { threadId: nativeThreadId, fidelity: "durable" } },
    ]);
  }),
);

it.effect(
  "looks up an unknown UUID without a discovery host and never retries native discovery",
  () =>
    Effect.gen(function* () {
      const { service, calls } = yield* fixture();

      assert.isNull(yield* service.resolve(nativeThreadId));
      assert.deepEqual(calls, [
        { owner: "native", input: { threadId: nativeThreadId, fidelity: "durable" } },
        { owner: "runtime", threadId: nativeThreadId },
      ]);
    }),
);

it.effect("retains Runtime failures without turning them into a native fallback", () =>
  Effect.gen(function* () {
    const threadId = "thread:task:unavailable";
    const unavailable = new AgentRuntimeApplicationError({
      operation: "identify",
      message: "Runtime unavailable",
    });
    const { service, calls } = yield* fixture({ runtimeError: unavailable });

    const failure = yield* service.resolve(threadId).pipe(Effect.flip);
    assert.instanceOf(failure, ConversationIdentityError);
    assert.strictEqual(failure.cause, unavailable);
    assert.deepEqual(calls, [
      { owner: "native", input: { threadId, fidelity: "durable" } },
      { owner: "runtime", threadId },
    ]);
  }),
);

it.effect("retains native ownership lookup failures without trying another owner", () =>
  Effect.gen(function* () {
    const unavailable = new CodexThreadDirectoryError({
      operation: "read",
      threadId: nativeThreadId,
      cause: new Error("Core unavailable"),
    });
    const { service, calls } = yield* fixture({ nativeError: unavailable });

    const failure = yield* service.resolve(nativeThreadId).pipe(Effect.flip);
    assert.instanceOf(failure, ConversationIdentityError);
    assert.strictEqual(failure.cause, unavailable);
    assert.deepEqual(calls, [
      { owner: "native", input: { threadId: nativeThreadId, fidelity: "durable" } },
    ]);
  }),
);

it.effect.each([
  { label: "empty", threadId: "" },
  { label: "whitespace", threadId: " \n\t " },
  { label: "overlong", threadId: "a".repeat(513) },
])("does no lookup work for an $label identity", ({ threadId }) =>
  Effect.gen(function* () {
    const { service, calls } = yield* fixture();
    assert.isNull(yield* service.resolve(threadId));
    assert.deepEqual(calls, []);
  }),
);

it.effect("normalizes surrounding whitespace before either owner receives the identity", () =>
  Effect.gen(function* () {
    const identity = runtimeIdentity(runtimeRoot);
    const { service, calls } = yield* fixture({ runtime: identity });

    assert.strictEqual(yield* service.resolve(` \n${runtimeRoot}\t `), identity);
    assert.deepEqual(calls, [
      { owner: "native", input: { threadId: runtimeRoot, fidelity: "durable" } },
      { owner: "runtime", threadId: runtimeRoot },
    ]);
  }),
);

it.effect("names a registered remote host from settings without consulting Runtime", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* fixture({
      registered: summary({ executionHostId: "build-box" }),
      hosts,
    });
    const identity = yield* service.resolve(nativeThreadId);

    assert.deepInclude(identity, {
      execution: "native-codex",
      executionHostId: "build-box",
      host: { id: "build-box", name: "Build box" },
    });
    assert.deepEqual(calls, [
      { owner: "native", input: { threadId: nativeThreadId, fidelity: "durable" } },
      { owner: "settings" },
    ]);
  }),
);

it.effect("keeps the remote execution target when display settings cannot be read", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* fixture({
      registered: summary({ executionHostId: "build-box" }),
      settingsError: new ApplicationSettingsError({
        operation: "snapshot",
        cause: new Error("Settings unavailable"),
      }),
    });
    const identity = yield* service.resolve(nativeThreadId);

    assert.deepInclude(identity, {
      execution: "native-codex",
      executionHostId: "build-box",
      host: { id: "build-box", name: "build-box" },
    });
    assert.deepEqual(calls, [
      { owner: "native", input: { threadId: nativeThreadId, fidelity: "durable" } },
      { owner: "settings" },
    ]);
  }),
);

describe("native conversation presentation", () => {
  it("names a local chat with its native execution owner and current model", () => {
    assert.deepEqual(nativeConversationIdentity(summary(), null), {
      execution: "native-codex",
      executionHostId: "local",
      threadId: nativeThreadId,
      sessionId: "session:native",
      title: "Release notes",
      role: "chat",
      agent: { kind: "codex", providerInstanceId: null, model: "gpt-6.1-sol", effort: "high" },
      archived: false,
      host: null,
    });
  });

  it("preserves archival and missing model data without inferring another provider", () => {
    assert.deepInclude(
      nativeConversationIdentity(
        summary({ sessionId: undefined, executionProfile: null, archived: true }),
        null,
      ),
      {
        execution: "native-codex",
        sessionId: null,
        agent: { kind: "codex", providerInstanceId: null, model: null, effort: null },
        archived: true,
      },
    );
  });

  it("uses the host name when configured and its durable id when the host was removed", () => {
    assert.deepEqual(
      nativeConversationIdentity(summary({ executionHostId: "build-box" }), hosts).host,
      { id: "build-box", name: "Build box" },
    );
    assert.deepEqual(nativeConversationIdentity(summary({ executionHostId: "gone" }), hosts).host, {
      id: "gone",
      name: "gone",
    });
  });

  it("prefers a title, then a child nickname, then preview text", () => {
    const child = summary({ agentNickname: " Explorer ", agentPath: "/root/explorer" });
    assert.deepInclude(nativeConversationIdentity(child, null), {
      title: "Release notes",
      role: "subagent",
    });
    assert.deepInclude(nativeConversationIdentity({ ...child, threadName: "  " }, null), {
      title: "Explorer",
      role: "subagent",
    });
    assert.deepInclude(
      nativeConversationIdentity({ ...child, threadName: null, agentNickname: null }, null),
      { title: "Draft the notes", role: "subagent" },
    );
    assert.deepInclude(nativeConversationIdentity(summary({ threadName: "  " }), null), {
      title: "Draft the notes",
      role: "chat",
    });
  });

  it("projects automation instructions without their transport envelope and names empty chats", () => {
    const threadPreview = buildAutomationHeartbeatPrompt(
      { id: "automation:check", prompt: "Check the build status" },
      Date.parse("2026-11-21T00:00:00.000Z"),
    );
    assert.strictEqual(
      nativeConversationIdentity(summary({ threadName: null, threadPreview }), null).title,
      "Check the build status",
    );
    assert.strictEqual(
      nativeConversationIdentity(summary({ threadName: null, threadPreview: "  " }), null).title,
      "Untitled chat",
    );
  });
});
