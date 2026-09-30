/* oxlint-disable effecttsgo/async-function, effecttsgo/process-env, effecttsgo/strict-effect-provide -- Native conformance uses the scoped Promise probe adapter and an explicit disposable process environment; this test is its composition root. */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { parse as parseToml } from "smol-toml";
import type {
  ConfigReadResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadTurnsListResponse,
} from "@nodex/codex-app-server-protocol/v2";
import { withCodexProbeSession } from "../../../../scripts/codex-probe-session";
import { ScopedCallbackRuntime, layer as callbacksLive } from "../../app/ScopedCallbackRuntime";
import {
  assertCodexAccountHomeIdentity,
  codexAccountHomeEnvironment,
  codexAccountHomeLaunchArgs,
  prepareCodexAccountHome,
} from "./CodexAccountHome";

const execute = promisify(execFile);
const binaryPath = process.env.NODEX_TEST_PROFILE_CODEX_BINARY;
const inheritedPath = process.env.PATH;

// Native conformance is opt-in to the exact staged executable. No Turn or model
// request is submitted, and all account/configuration files live in this fixture.
it.effect.skipIf(!binaryPath)(
  "continues one paginated native session across account directories without forking or truncating history",
  () =>
    Effect.gen(function* () {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "nodex-native-account-")));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(root, { recursive: true, force: true })),
      );
      const sharedHome = join(root, "shared");
      mkdirSync(sharedHome);
      const threadId = randomUUID();
      const stamp = "2026-09-30T00:00:00Z";
      const config = 'model = "gpt-5"\n';
      writeFileSync(join(sharedHome, "config.toml"), config);
      writeFileSync(
        join(sharedHome, "work.config.toml"),
        'model = "gpt-5-codex"\n[mcp_servers.profile_fixture]\ncommand = "true"\nenabled = false\n',
      );
      const sessions = join(sharedHome, "sessions", "2026", "09", "30");
      mkdirSync(sessions, { recursive: true });
      const history = [
        {
          type: "session_meta",
          payload: {
            id: threadId,
            session_id: threadId,
            timestamp: stamp,
            cwd: root,
            originator: "nodex-account-test",
            cli_version: "0.155.0",
            source: "cli",
            model_provider: "openai",
            history_mode: "legacy",
          },
        },
        ...Array.from({ length: 3 }, (_, index) => [
          {
            type: "event_msg",
            payload: {
              type: "task_started",
              turn_id: `turn-${index}`,
              model_context_window: 128000,
            },
          },
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: `Retain turn ${index}` }],
            },
          },
          {
            type: "event_msg",
            payload: {
              type: "user_message",
              message: `Retain turn ${index}`,
              images: [],
              local_images: [],
              text_elements: [],
            },
          },
          {
            type: "event_msg",
            payload: { type: "task_complete", turn_id: `turn-${index}`, last_agent_message: null },
          },
        ]).flat(),
      ];
      const rolloutPath = join(sessions, `rollout-2026-09-30T00-00-00-${threadId}.jsonl`);
      writeFileSync(
        rolloutPath,
        history
          .map((row, ordinal) => JSON.stringify({ timestamp: stamp, ordinal, ...row }))
          .join("\n") + "\n",
      );
      const migration = yield* Effect.tryPromise(() =>
        execute(
          binaryPath!,
          [
            "-c",
            'cli_auth_credentials_store="file"',
            "migrate-rollouts",
            "--apply",
            "--thread",
            threadId,
            "--json",
          ],
          { env: { PATH: inheritedPath, HOME: root, CODEX_HOME: sharedHome }, timeout: 10000 },
        ),
      );
      const migrationReport = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        migration.stdout,
      );
      expect(migrationReport).toMatchObject({
        outcomes: [{ thread_id: threadId, status: "migrated" }],
      });
      const metadata = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        readFileSync(rolloutPath, "utf8").split("\n")[0]!,
      );
      expect(metadata).toMatchObject({
        payload: { history_mode: "paginated" },
      });
      const callbacks = yield* ScopedCallbackRuntime;
      const accountHomes = [null, join(root, "personal"), join(root, "work")];
      for (const [accountIndex, accountHome] of accountHomes.entries()) {
        const home = prepareCodexAccountHome({
          sharedHome,
          accountHome,
          platform: process.platform,
        });
        yield* withCodexProbeSession(
          callbacks,
          {
            binaryPath: binaryPath!,
            args: [
              "app-server",
              "-c",
              'cli_auth_credentials_store="file"',
              ...codexAccountHomeLaunchArgs(home),
            ],
            env: codexAccountHomeEnvironment(home, { PATH: inheritedPath, HOME: root }),
            expectedCodexHome: home.effectiveHome,
            clientInfo: { name: "nodex-account-test", title: "Native Account Test", version: "1" },
            requestTimeout: "20 seconds",
          },
          async (client) => {
            const read = await client.request<ThreadReadResponse>("thread/read", {
              threadId,
              includeTurns: false,
            });
            expect(read.thread.id).toBe(threadId);
            if (accountIndex > 0) expect(read.thread.name).toBe(`Account ${accountIndex - 1}`);
            const resumed = await client.request<ThreadResumeResponse>("thread/resume", {
              threadId,
              excludeTurns: true,
              deferGoalContinuation: true,
            });
            expect(resumed.thread.id).toBe(threadId);
            const turns = await client.request<ThreadTurnsListResponse>("thread/turns/list", {
              threadId,
              itemsView: "full",
              limit: 100,
            });
            expect(turns.data.map((turn) => turn.id)).toEqual(["turn-2", "turn-1", "turn-0"]);
            expect(turns.data.flatMap((turn) => turn.items)).toHaveLength(3);
            await client.request("thread/name/set", { threadId, name: `Account ${accountIndex}` });
            const fixtureKey = `sk-nodex-fixture-${accountHome === null ? "shared" : accountHome.endsWith("personal") ? "personal" : "work"}`;
            await client.request("account/login/start", { type: "apiKey", apiKey: fixtureKey });
            expect(
              JSON.parse(readFileSync(join(home.effectiveHome, "auth.json"), "utf8")),
            ).toMatchObject({ OPENAI_API_KEY: fixtureKey });
            expect(JSON.parse(readFileSync(join(sharedHome, "auth.json"), "utf8"))).toMatchObject({
              OPENAI_API_KEY: "sk-nodex-fixture-shared",
            });
            const settings = await client.request<ConfigReadResponse>("config/read", {
              includeLayers: false,
            });
            expect(settings.config.model).toBe("gpt-5");
            await client.request("config/value/write", {
              keyPath: "hide_agent_reasoning",
              value: accountHome !== null,
              mergeStrategy: "replace",
            });
            const profile = await execute(
              binaryPath!,
              [
                "--profile",
                "work",
                "-c",
                'cli_auth_credentials_store="file"',
                "mcp",
                "list",
                "--json",
              ],
              {
                env: codexAccountHomeEnvironment(home, { PATH: inheritedPath, HOME: root }),
                timeout: 10000,
              },
            );
            expect(JSON.parse(profile.stdout)).toEqual([
              expect.objectContaining({ name: "profile_fixture", enabled: false }),
            ]);
            if (accountIndex === accountHomes.length - 1) {
              await client.request("thread/archive", { threadId });
              await client.request("thread/unarchive", { threadId });
              await client.request("thread/delete", { threadId });
              expect(() => assertCodexAccountHomeIdentity(home, process.platform)).not.toThrow();
            }
          },
        );
      }
      expect(parseToml(readFileSync(join(sharedHome, "config.toml"), "utf8"))).toMatchObject({
        model: "gpt-5",
        hide_agent_reasoning: true,
      });
      expect(parseToml(readFileSync(join(sharedHome, "work.config.toml"), "utf8"))).toMatchObject({
        model: "gpt-5-codex",
      });
    }).pipe(Effect.scoped, Effect.provide(callbacksLive)),
);
