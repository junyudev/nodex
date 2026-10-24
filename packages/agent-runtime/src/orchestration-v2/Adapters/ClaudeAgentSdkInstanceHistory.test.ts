/* @effect-diagnostics asyncFunction:off -- Fixtures exercise the native SDK's Promise-based session storage. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createClaudeSessionStores } from "../../provider/ClaudeSessionStore.ts";
import { ClaudeAgentSdkQueryRunner, layerQueryRunner } from "./ClaudeAdapterV2.ts";

const runnerLayer = layerQueryRunner.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
    ),
  ),
);

// SDK initialization sets these two flags; every account/configuration variable stays fenced.
const accountEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "NoDefaultCurrentDirectoryInExePath" && key !== "CLAUDE_AGENT_SDK_VERSION",
    ),
  );

const fixture = Effect.fnUntraced(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "nodex-claude-instance-history-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );
  const cwd = path.join(root, "workspace");
  const sessionId = randomUUID();
  const key = { projectKey: "source-workspace", sessionId };
  const stores = createClaudeSessionStores();
  const homes = ["alpha", "beta", "restored"].map((name) => path.join(root, name));
  const accountAlias = path.join(root, "alpha-account");
  yield* Effect.promise(async () => {
    await mkdir(cwd);
    await Promise.all(
      homes.map(async (home) => {
        const marker = path.basename(home);
        await mkdir(home);
        await stores(home).append(key, [
          {
            type: "user",
            uuid: "message:original",
            sessionId,
            parentUuid: null,
            message: { role: "user", content: `history from ${marker}` },
          },
          {
            type: "assistant",
            uuid: "message:reply",
            sessionId,
            parentUuid: "message:original",
            message: {
              role: "assistant",
              content: [{ type: "text", text: `reply from ${marker}` }],
            },
          },
        ]);
        const child = path.join(home, "projects", key.projectKey, sessionId, "subagents");
        await mkdir(child, { recursive: true });
        await writeFile(
          path.join(child, "agent-child.jsonl"),
          JSON.stringify({
            type: "assistant",
            uuid: "message:child",
            message: { role: "assistant", content: [{ type: "text", text: marker }] },
          }) + "\n",
        );
        await writeFile(
          path.join(child, "agent-child.meta.json"),
          JSON.stringify({ toolUseId: `tool:${marker}`, parentAgentId: null }),
        );
      }),
    );
    await symlink(homes[0]!, accountAlias, "dir");
  });
  const readMessages = async (home: string, nativeSessionId: string) =>
    (await stores(home).load({ ...key, sessionId: nativeSessionId }))
      ?.filter((entry) => entry.type === "user" || entry.type === "assistant")
      .map((entry) => entry.message) ?? null;
  return {
    cwd,
    sessionId,
    homes,
    accountAlias,
    readMessages,
    identity: {
      sessionId,
      threadId: ThreadId.make("thread:instance-history"),
      providerSessionId: ProviderSessionId.make("provider-session:instance-history"),
    },
  };
});

it.live("forks the same native Session concurrently in each configured instance", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const runner = yield* ClaudeAgentSdkQueryRunner;
    const beforeEnvironment = accountEnvironment();
    const homes = f.homes.slice(0, 2);
    const forks = yield* Effect.all(
      homes.map((home, index) =>
        runner.forkSession({
          ...f.identity,
          configDirectory: index === 0 ? f.accountAlias : path.relative(f.cwd, home),
          options: { dir: f.cwd },
        }),
      ),
      { concurrency: "unbounded" },
    );
    expect(new Set([f.sessionId, ...forks.map((fork) => fork.sessionId)]).size).toBe(3);
    yield* Effect.promise(async () => {
      for (const [index, fork] of forks.entries()) {
        const home = homes[index]!;
        expect(await f.readMessages(home, fork.sessionId)).toEqual(
          await f.readMessages(home, f.sessionId),
        );
        expect(await f.readMessages(homes[1 - index]!, fork.sessionId)).toBeNull();
      }
    });
    expect(accountEnvironment()).toEqual(beforeEnvironment);
  }).pipe(Effect.provide(runnerLayer)),
);

it.live("looks up each instance's subagent without changing process-wide configuration", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const runner = yield* ClaudeAgentSdkQueryRunner;
    const beforeEnvironment = accountEnvironment();
    const tools = yield* Effect.all(
      f.homes.slice(0, 2).map((configDirectory) =>
        runner.subagentLaunchToolUseId({
          ...f.identity,
          configDirectory,
          dir: f.cwd,
          agentId: "child",
        }),
      ),
      { concurrency: "unbounded" },
    );
    expect(tools).toEqual(["tool:alpha", "tool:beta"]);
    expect(accountEnvironment()).toEqual(beforeEnvironment);
  }).pipe(Effect.provide(runnerLayer)),
);

it.live("gives restored history precedence over the configured account for fork and lookup", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const runner = yield* ClaudeAgentSdkQueryRunner;
    const configDirectory = f.homes[0]!;
    const restoredHistoryPath = f.homes[2]!;
    const source = { ...f.identity, configDirectory, restoredHistoryPath };
    const [fork, tool] = yield* Effect.all(
      [
        runner.forkSession({ ...source, options: { dir: f.cwd } }),
        runner.subagentLaunchToolUseId({ ...source, dir: f.cwd, agentId: "child" }),
      ],
      { concurrency: "unbounded" },
    );
    expect(tool).toBe("tool:restored");
    yield* Effect.promise(async () => {
      expect(await f.readMessages(restoredHistoryPath, fork.sessionId)).toEqual(
        await f.readMessages(restoredHistoryPath, f.sessionId),
      );
      expect(await f.readMessages(configDirectory, fork.sessionId)).toBeNull();
    });
  }).pipe(Effect.provide(runnerLayer)),
);
