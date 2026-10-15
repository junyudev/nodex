/* @effect-diagnostics asyncFunction:off -- The fixture exercises the native SDK subprocess boundary. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  ClaudeAgentSdkQueryRunner,
  layerQueryRunner,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { createClaudeRestoredSessionStores } from "./ClaudeRestoredSessionStore.ts";

const sessionId = "11111111-1111-7111-8111-111111111111";
const nativePeer = `
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const config = process.env.CLAUDE_CONFIG_DIR;
const project = fs.readdirSync(path.join(config, "projects"))[0];
const primary = fs.readdirSync(path.join(config, "projects", project)).find((name) => name.endsWith(".jsonl"));
const id = primary.slice(0, -".jsonl".length);
const transcript = path.join(config, "projects", project, id + ".jsonl");
const main = fs.readFileSync(transcript, "utf8");
const metadata = JSON.parse(fs.readFileSync(path.join(config, "projects", project, id, "subagents", "agent-child.meta.json"), "utf8"));
const auth = JSON.parse(fs.readFileSync(path.join(config, ".credentials.json"), "utf8"));
fs.writeFileSync(process.env.NODEX_TEST_EVIDENCE, JSON.stringify({ temporary: config !== process.env.NODEX_TEST_AUTH_HOME, history: main.includes("captured before restore"), toolUseId: metadata.toolUseId, account: auth.fixtureMarker === "configured-account" }));
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.type === "control_request") {
    emit({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { commands: [], models: [], output_style: "default" } } });
    continue;
  }
  if (request.type !== "user") continue;
  if (process.env.NODEX_TEST_CORRUPT_HISTORY_PATH) fs.writeFileSync(process.env.NODEX_TEST_CORRUPT_HISTORY_PATH, "{invalid json");
  const entry = { type: "assistant", uuid: "message:continued", sessionId: id, parentUuid: "message:original", message: { role: "assistant", content: [{ type: "text", text: "continued after restore" }] } };
  emit({ type: "transcript_mirror", filePath: transcript, entries: [entry] });
  emit({ type: "result", subtype: "success", session_id: id, uuid: "result:continued", is_error: false, result: "continued after restore", duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: "end_turn", total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
}
`;
const queryRunnerLayer = layerQueryRunner.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
    ),
  ),
);

it.live.each(["durable", "rejected"] as const)(
  "uses the actual SDK's authenticated resume home and exposes a %s history mirror",
  (mirror) =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "nodex-claude-sdk-restore-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
      const home = path.join(root, "history");
      const auth = path.join(root, "account");
      const cwd = path.join(root, "workspace");
      const peer = path.join(root, "peer.mjs");
      const evidence = path.join(root, "evidence.json");
      const store = createClaudeRestoredSessionStores()(home);
      const key = { projectKey: "captured-project", sessionId };
      yield* Effect.promise(async () => {
        await Promise.all([mkdir(home), mkdir(auth), mkdir(cwd)]);
        await writeFile(peer, nativePeer);
        await writeFile(
          path.join(auth, ".credentials.json"),
          JSON.stringify({ fixtureMarker: "configured-account" }),
        );
        await store.append(key, [
          {
            type: "user",
            uuid: "message:original",
            sessionId,
            parentUuid: null,
            message: { role: "user", content: "captured before restore" },
          },
        ]);
        const children = path.join(home, "projects", key.projectKey, sessionId, "subagents");
        await mkdir(children, { recursive: true });
        await writeFile(
          path.join(children, "agent-child.jsonl"),
          JSON.stringify({
            type: "assistant",
            uuid: "message:child",
            message: { role: "assistant", content: [] },
          }) + "\n",
        );
        await writeFile(
          path.join(children, "agent-child.meta.json"),
          JSON.stringify({ toolUseId: "tool:launch" }),
        );
      });
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const query = yield* runner.open({
        threadId: ThreadId.make("thread:restored"),
        providerSessionId: ProviderSessionId.make("provider-session:restored"),
        options: {
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
          resume: sessionId,
          cwd,
          restoredHistoryPath: home,
          pathToClaudeCodeExecutable: peer,
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: auth,
            NODEX_TEST_AUTH_HOME: auth,
            NODEX_TEST_EVIDENCE: evidence,
            ...(mirror === "rejected"
              ? {
                  NODEX_TEST_CORRUPT_HISTORY_PATH: path.join(
                    home,
                    "projects",
                    key.projectKey,
                    `${sessionId}.jsonl`,
                  ),
                }
              : {}),
          },
        },
      });
      yield* Effect.addFinalizer(() => query.close.pipe(Effect.ignore));
      const incoming = yield* query.messages.pipe(
        Stream.filter((message) => message.type === "result"),
        Stream.runHead,
        Effect.result,
        Effect.forkChild,
      );
      yield* query.offer({
        type: "user",
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: "user", content: "Continue" },
      });
      const result = yield* Fiber.join(incoming);
      yield* query.close;
      if (mirror === "durable") {
        expect(result._tag).toBe("Success");
        if (result._tag !== "Success") return;
        expect(Option.getOrThrow(result.success)).toMatchObject({
          type: "result",
          result: "continued after restore",
        });
      } else {
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") return;
        expect(result.failure.method).toBe("sessionStore.append");
      }
      yield* Effect.promise(async () => {
        expect(JSON.parse(await readFile(evidence, "utf8"))).toEqual({
          temporary: true,
          history: true,
          toolUseId: "tool:launch",
          account: true,
        });
        if (mirror === "durable")
          expect((await store.load(key))?.at(-1)).toMatchObject({
            uuid: "message:continued",
            message: { content: [{ text: "continued after restore" }] },
          });
        await expect(readFile(path.join(home, ".credentials.json"))).rejects.toBeDefined();
      });
    }).pipe(Effect.provide(queryRunnerLayer)),
);

it.live(
  "refuses missing managed history before the real SDK can fall back to the account home",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "nodex-claude-sdk-missing-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
      const home = path.join(root, "history");
      const auth = path.join(root, "account");
      const cwd = path.join(root, "workspace");
      const peer = path.join(root, "peer.mjs");
      const evidence = path.join(root, "evidence.json");
      yield* Effect.promise(async () => {
        await Promise.all([mkdir(home), mkdir(auth), mkdir(cwd)]);
        await writeFile(peer, nativePeer);
        await writeFile(
          path.join(auth, ".credentials.json"),
          JSON.stringify({ fixtureMarker: "configured-account" }),
        );
        const project = path.join(auth, "projects", "account-project");
        const child = path.join(project, sessionId, "subagents");
        await mkdir(child, { recursive: true });
        await writeFile(
          path.join(project, `${sessionId}.jsonl`),
          JSON.stringify({ type: "user", message: { content: "external account history" } }) + "\n",
        );
        await writeFile(
          path.join(child, "agent-child.meta.json"),
          JSON.stringify({ toolUseId: "external-tool" }),
        );
      });
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const query = yield* runner.open({
        threadId: ThreadId.make("thread:missing"),
        providerSessionId: ProviderSessionId.make("provider-session:missing"),
        options: {
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
          resume: sessionId,
          cwd,
          restoredHistoryPath: home,
          pathToClaudeCodeExecutable: peer,
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: auth,
            NODEX_TEST_AUTH_HOME: auth,
            NODEX_TEST_EVIDENCE: evidence,
          },
        },
      });
      yield* Effect.addFinalizer(() => query.close.pipe(Effect.ignore));
      const result = yield* query.messages.pipe(Stream.runHead, Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(String(result.failure.cause)).toContain(
        "Restored Claude session history is unavailable",
      );
      yield* Effect.promise(async () => {
        await expect(readFile(evidence)).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          await createClaudeRestoredSessionStores()(home).load({
            projectKey: "account-project",
            sessionId,
          }),
        ).toBeNull();
      });
    }).pipe(Effect.provide(queryRunnerLayer)),
);
