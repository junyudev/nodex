import { assert, it } from "@effect/vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe } from "vite-plus/test";
import {
  ApplicationSettingsConflictError,
  make as makeApplicationSettings,
} from "./ApplicationSettings";
import { SETTINGS_DOCUMENT_MAX_BYTES } from "./settings-document";
import { INBOX_SUGGESTION_MODES, type UpdateInboxSettingsInput } from "../../shared/inbox";

const roots: string[] = [];

function fixture(source?: string | Uint8Array) {
  const root = mkdtempSync(path.join(tmpdir(), "nodex-application-settings-"));
  roots.push(root);
  const settingsPath = path.join(root, "config.toml");
  if (source !== undefined) writeFileSync(settingsPath, source);
  return { root, settingsPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ApplicationSettings", () => {
  it.effect("persists Profile predictions and publishes only successful effective changes", () =>
    Effect.gen(function* () {
      const { root, settingsPath } = fixture('[plugin]\nname = "keep"\n');
      const input = { environment: {}, hostHomeDirectory: root, settingsPath };
      const settings = yield* makeApplicationSettings(input);
      assert.deepEqual((yield* settings.snapshot()).composerPredictions, { enabled: true });
      const disabled = yield* Deferred.make<void>();
      const changes = yield* settings.composerPredictionSettingsChanges.pipe(
        Stream.tap(() => Deferred.succeed(disabled, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* settings.update({ type: "update-composer-predictions", input: { enabled: false } });
      yield* Deferred.await(disabled);
      yield* settings.update({ type: "update-composer-predictions", input: { enabled: false } });
      const reopened = yield* makeApplicationSettings(input);
      assert.deepEqual((yield* reopened.snapshot()).composerPredictions, { enabled: false });
      const malformed = yield* Effect.result(
        settings.update({
          type: "update-composer-predictions",
          input: { enabled: "yes" as unknown as boolean },
        }),
      );
      assert.strictEqual(malformed._tag, "Failure");
      assert.deepEqual((yield* settings.snapshot()).composerPredictions, { enabled: false });
      yield* settings.update({ type: "update-composer-predictions", input: { enabled: true } });
      assert.deepEqual(yield* Fiber.join(changes), [{ enabled: false }, { enabled: true }]);
      assert.deepEqual(parseToml(readFileSync(settingsPath, "utf8")).plugin, { name: "keep" });
    }),
  );

  it.effect(
    "keeps settings writable while a slow prediction observer catches up to the latest value",
    () =>
      Effect.gen(function* () {
        const { root, settingsPath } = fixture();
        const settings = yield* makeApplicationSettings({
          environment: {},
          hostHomeDirectory: root,
          settingsPath,
        });
        const observing = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const observed: boolean[] = [];
        const observer = yield* settings.composerPredictionSettingsChanges.pipe(
          Stream.take(2),
          Stream.runForEach((value) =>
            Effect.gen(function* () {
              observed.push(value.enabled);
              if (observed.length !== 1) return;
              yield* Deferred.succeed(observing, undefined);
              yield* Deferred.await(resume);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* settings.update({ type: "update-composer-predictions", input: { enabled: false } });
        yield* Deferred.await(observing);
        for (let index = 0; index < 32; index += 1) {
          yield* settings.update({
            type: "update-composer-predictions",
            input: { enabled: index % 2 === 0 },
          });
        }
        assert.deepEqual((yield* settings.snapshot()).composerPredictions, { enabled: false });
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(observer);
        assert.deepEqual(observed, [false, false]);
      }),
  );

  it.effect.each(["default", "environment"] as const)(
    "uses the %s Codex home without modifying Profile history or native configuration",
    (source) =>
      Effect.gen(function* () {
        const { root, settingsPath } = fixture('[plugin]\nname = "keep"\n');
        const hostHomeDirectory = path.join(root, "user");
        const nativeHome =
          source === "default"
            ? path.join(hostHomeDirectory, ".codex")
            : path.join(root, "inherited-codex");
        const legacyHome = path.join(root, "agent");
        mkdirSync(path.join(legacyHome, "sessions"), { recursive: true });
        mkdirSync(nativeHome, { recursive: true });
        const rolloutPath = path.join(legacyHome, "sessions", "rollout-retained.jsonl");
        writeFileSync(
          rolloutPath,
          `${JSON.stringify({
            type: "session_meta",
            payload: {
              id: "11111111-1111-4111-8111-111111111111",
              timestamp: "2026-09-30T00:00:00.000Z",
              cwd: root,
              model_provider: "openai",
            },
          })}\n`,
        );
        const nativeConfigPath = path.join(nativeHome, "config.toml");
        const nativeHooksPath = path.join(nativeHome, "hooks.json");
        const legacyConfigPath = path.join(legacyHome, "config.toml");
        const legacyHooksPath = path.join(legacyHome, "hooks.json");
        writeFileSync(nativeConfigPath, 'model = "shared-model"\n');
        writeFileSync(nativeHooksPath, '{"hooks":{"SessionStart":[]}}\n');
        writeFileSync(legacyConfigPath, 'model = "profile-model"\n');
        writeFileSync(legacyHooksPath, '{"hooks":{"Stop":[]}}\n');
        const files = [
          settingsPath,
          rolloutPath,
          nativeConfigPath,
          nativeHooksPath,
          legacyConfigPath,
          legacyHooksPath,
        ];
        const contentsBefore = files.map((file) => readFileSync(file));
        const entriesBefore = readdirSync(root, { recursive: true, encoding: "utf8" }).sort(
          (a, b) => a.localeCompare(b),
        );
        const settings = yield* makeApplicationSettings({
          environment: source === "environment" ? { CODEX_HOME: nativeHome } : {},
          hostHomeDirectory,
          settingsPath,
        });
        const snapshot = yield* settings.snapshot();
        assert.strictEqual(snapshot.codexHome.homePath, "");
        assert.strictEqual(snapshot.codexHome.resolvedHomePath, nativeHome);
        assert.strictEqual(snapshot.codexHome.activeHomePath, nativeHome);
        assert.strictEqual(snapshot.codexHome.source, source);
        assert.isFalse(snapshot.codexHome.restartRequired);
        assert.deepEqual(yield* settings.snapshot(), snapshot);
        assert.deepEqual(
          files.map((file) => readFileSync(file)),
          contentsBefore,
        );
        assert.deepEqual(
          readdirSync(root, { recursive: true, encoding: "utf8" }).sort((a, b) =>
            a.localeCompare(b),
          ),
          entriesBefore,
        );
      }),
  );

  it.effect(
    "stages the Codex home without moving the active runtime and resets to native defaults",
    () =>
      Effect.gen(function* () {
        const { settingsPath } = fixture('[plugin]\nname = "keep"\n');
        const environment = { CODEX_HOME: "/host/native-codex" };
        const settings = yield* makeApplicationSettings({
          environment,
          hostHomeDirectory: "/host/user",
          settingsPath,
        });
        const before = yield* settings.snapshot();
        assert.deepEqual(before.codexHome, {
          homePath: "",
          resolvedHomePath: "/host/native-codex",
          source: "environment",
          accountHomePath: "",
          resolvedAccountHomePath: null,
          activeHomePath: "/host/native-codex",
          activeAccountHomePath: null,
          restartRequired: false,
        });
        environment.CODEX_HOME = "/changed-after-startup";
        const staged = yield* settings.update({
          type: "update-codex-home",
          input: { homePath: " ~/work-codex " },
        });
        assert.deepEqual(staged.codexHome, {
          homePath: "/host/user/work-codex",
          resolvedHomePath: "/host/user/work-codex",
          source: "settings",
          accountHomePath: "",
          resolvedAccountHomePath: null,
          activeHomePath: "/host/native-codex",
          activeAccountHomePath: null,
          restartRequired: true,
        });
        const document = parseToml(readFileSync(settingsPath, "utf8")) as {
          server: { codex_home?: string };
          plugin: { name: string };
        };
        assert.strictEqual(document.server.codex_home, "/host/user/work-codex");
        assert.strictEqual(document.plugin.name, "keep");
        const reopened = yield* makeApplicationSettings({
          environment: {},
          hostHomeDirectory: "/host/user",
          settingsPath,
        });
        const reopenedSnapshot = yield* reopened.snapshot();
        assert.strictEqual(reopenedSnapshot.codexHome.activeHomePath, "/host/user/work-codex");
        assert.isFalse(reopenedSnapshot.codexHome.restartRequired);
        const reset = yield* settings.update({
          type: "update-codex-home",
          input: { homePath: "" },
        });
        assert.deepEqual(reset.codexHome, before.codexHome);
        const resetDocument = parseToml(readFileSync(settingsPath, "utf8")) as {
          server: { codex_home?: string };
        };
        assert.isUndefined(resetDocument.server.codex_home);
      }),
  );

  it.effect(
    "stages account changes independently while retaining shared home and unrelated config",
    () =>
      Effect.gen(function* () {
        const { settingsPath } = fixture('[plugin]\nname = "keep"\n');
        const input = { environment: {}, hostHomeDirectory: "/host/user", settingsPath };
        const settings = yield* makeApplicationSettings(input);
        const initial = yield* settings.snapshot();
        const staged = yield* settings.update({
          type: "update-codex-home",
          input: {
            homePath: "",
            accountHomePath: " ~/codex-personal ",
          },
        });
        assert.strictEqual(staged.codexHome.activeHomePath, initial.codexHome.activeHomePath);
        assert.isNull(staged.codexHome.activeAccountHomePath);
        assert.strictEqual(staged.codexHome.resolvedAccountHomePath, "/host/user/codex-personal");
        assert.isTrue(staged.codexHome.restartRequired);
        const homeOnly = yield* settings.update({
          type: "update-codex-home",
          input: { homePath: "" },
        });
        assert.strictEqual(
          homeOnly.codexHome.resolvedAccountHomePath,
          staged.codexHome.resolvedAccountHomePath,
        );
        const document = parseToml(readFileSync(settingsPath, "utf8")) as {
          server: { codex_account_home: string };
          plugin: { name: string };
        };
        assert.strictEqual(document.server.codex_account_home, "/host/user/codex-personal");
        assert.strictEqual(document.plugin.name, "keep");
        const reopened = yield* makeApplicationSettings(input);
        const active = yield* reopened.snapshot();
        assert.strictEqual(active.codexHome.activeAccountHomePath, "/host/user/codex-personal");
        assert.isFalse(active.codexHome.restartRequired);
        const reset = yield* settings.update({
          type: "update-codex-home",
          input: { homePath: "", accountHomePath: "" },
        });
        assert.deepEqual(reset.codexHome, initial.codexHome);
      }),
  );

  it.effect("rejects invalid Codex paths before altering the settings document", () =>
    Effect.gen(function* () {
      const { settingsPath } = fixture("[server]\nhistory_retention = 41\n");
      const settings = yield* makeApplicationSettings({
        environment: {},
        hostHomeDirectory: "/host/user",
        settingsPath,
      });
      const initial = yield* settings.snapshot();
      assert.strictEqual(initial.codexHome.resolvedHomePath, "/host/user/.codex");
      assert.strictEqual(initial.codexHome.source, "default");
      const before = readFileSync(settingsPath);
      for (const homePath of ["relative/codex", "/invalid\0path", "x".repeat(4_097)]) {
        const result = yield* Effect.result(
          settings.update({ type: "update-codex-home", input: { homePath } }),
        );
        assert.isTrue(Result.isFailure(result));
        assert.deepEqual(readFileSync(settingsPath), before);
      }
    }),
  );

  it.effect("serializes concurrent setting-family mutations and preserves unknown TOML", () =>
    Effect.gen(function* () {
      const { settingsPath } = fixture('[plugin]\nname = "keep"\n\n[server]\nunknown = "keep"\n');
      const settings = yield* makeApplicationSettings({
        environment: {},
        settingsPath,
        hostHomeDirectory: path.dirname(settingsPath),
      });

      yield* Effect.all(
        [
          settings.update({
            type: "update-backup",
            input: {
              autoEnabled: true,
              intervalHours: 3,
              retentionCount: 7,
              retentionGiB: 12,
            },
          }),
          settings.update({ type: "update-history", input: { retentionCount: 41 } }),
        ],
        { concurrency: "unbounded" },
      );

      const document = parseToml(readFileSync(settingsPath, "utf8")) as {
        readonly plugin?: { readonly name?: unknown };
        readonly server?: Record<string, unknown>;
      };
      assert.deepEqual(document.plugin, { name: "keep" });
      assert.strictEqual(document.server?.unknown, "keep");
      assert.strictEqual(document.server?.backup_interval_hours, 3);
      assert.strictEqual(document.server?.history_retention, 41);
    }),
  );

  it.effect.each(INBOX_SUGGESTION_MODES)("persists the Inbox's %s suggestion mode", (mode) =>
    Effect.gen(function* () {
      const { root, settingsPath } = fixture();
      const input = { environment: {}, hostHomeDirectory: root, settingsPath };
      const settings = yield* makeApplicationSettings(input);
      assert.strictEqual((yield* settings.snapshot()).inbox.suggestions, "automatic");
      yield* settings.update({ type: "update-inbox", input: { suggestions: mode } });
      const reopened = yield* makeApplicationSettings(input);
      assert.strictEqual((yield* reopened.snapshot()).inbox.suggestions, mode);
    }),
  );

  it.effect.each([true, false])("migrates the Inbox's former enabled=%s preference", (enabled) =>
    Effect.gen(function* () {
      const { root, settingsPath } = fixture(
        `[server]\ninbox_suggestions_enabled = ${enabled}\nunknown = "keep"\n`,
      );
      const input = { environment: {}, hostHomeDirectory: root, settingsPath };
      const settings = yield* makeApplicationSettings(input);
      const mode = enabled ? "automatic" : "off";
      assert.strictEqual((yield* settings.snapshot()).inbox.suggestions, mode);
      // A managed Inbox write canonicalizes the stored preference without losing its intent.
      yield* settings.update({ type: "update-inbox", input: { instructions: "Prefer notes" } });
      const server = parseToml(readFileSync(settingsPath, "utf8")).server as Record<
        string,
        unknown
      >;
      assert.strictEqual(server.inbox_suggestions, mode);
      assert.notProperty(server, "inbox_suggestions_enabled");
      assert.strictEqual(server.unknown, "keep");
      const reopened = yield* makeApplicationSettings(input);
      assert.strictEqual((yield* reopened.snapshot()).inbox.suggestions, mode);
    }),
  );

  it.effect("prefers the Inbox's mode over its former boolean and defaults invalid modes", () =>
    Effect.gen(function* () {
      for (const [configured, expected] of [
        ["on_request", "on_request"],
        ["invalid", "automatic"],
      ]) {
        const { root, settingsPath } = fixture(
          `[server]\ninbox_suggestions = "${configured}"\n` +
            (configured === "on_request" ? "inbox_suggestions_enabled = false\n" : ""),
        );
        const settings = yield* makeApplicationSettings({
          environment: {},
          hostHomeDirectory: root,
          settingsPath,
        });
        assert.strictEqual((yield* settings.snapshot()).inbox.suggestions, expected);
      }
    }),
  );

  it.effect("refuses invalid Inbox suggestion modes without changing the saved preference", () =>
    Effect.gen(function* () {
      const { root, settingsPath } = fixture();
      const settings = yield* makeApplicationSettings({
        environment: {},
        hostHomeDirectory: root,
        settingsPath,
      });
      yield* settings.update({ type: "update-inbox", input: { suggestions: "on_request" } });
      const before = readFileSync(settingsPath);
      for (const input of [
        { suggestions: "invalid" },
        { suggestions: true },
        { suggestionsEnabled: true },
      ]) {
        const result = yield* settings
          .update({
            type: "update-inbox",
            input: input as unknown as UpdateInboxSettingsInput,
          })
          .pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.deepEqual(readFileSync(settingsPath), before);
      }
      assert.strictEqual((yield* settings.snapshot()).inbox.suggestions, "on_request");
    }),
  );

  it.effect(
    "keeps the Inbox chat model, effort and speed with the Agent they were chosen for",
    () =>
      Effect.gen(function* () {
        const { root, settingsPath } = fixture();
        const input = { environment: {}, hostHomeDirectory: root, settingsPath };
        const settings = yield* makeApplicationSettings(input);
        assert.deepInclude((yield* settings.snapshot()).inbox, {
          suggestionsChooseModels: true,
          useModelGuide: true,
          showPageBesideNewChats: true,
        });
        const chosen = {
          instanceId: "codex",
          model: "gpt-6-astra",
          reasoningEffort: "high",
          serviceTier: "fast",
        };
        yield* settings.update({ type: "update-inbox", input: { chatAgent: chosen } });
        const reopened = yield* makeApplicationSettings(input);
        assert.deepEqual((yield* reopened.snapshot()).inbox.chatAgent, chosen);

        // Another Agent at its own defaults leaves nothing of the previous choice behind.
        const other = {
          instanceId: "opencode",
          model: null,
          reasoningEffort: null,
          serviceTier: null,
        };
        yield* reopened.update({ type: "update-inbox", input: { chatAgent: other } });
        assert.deepEqual(
          (yield* makeApplicationSettings(input).pipe(Effect.flatMap((next) => next.snapshot())))
            .inbox.chatAgent,
          other,
        );
        const server = (
          parseToml(readFileSync(settingsPath, "utf8")) as {
            readonly server?: Record<string, unknown>;
          }
        ).server;
        assert.strictEqual(server?.inbox_chat_agent, "opencode");
        yield* reopened.update({
          type: "update-inbox",
          input: {
            suggestionsChooseModels: false,
            useModelGuide: false,
            showPageBesideNewChats: false,
          },
        });
        assert.deepInclude(
          (yield* makeApplicationSettings(input).pipe(Effect.flatMap((next) => next.snapshot())))
            .inbox,
          {
            suggestionsChooseModels: false,
            useModelGuide: false,
            showPageBesideNewChats: false,
          },
        );
        assert.notProperty(server, "inbox_chat_model");
        assert.notProperty(server, "inbox_chat_effort");
        assert.notProperty(server, "inbox_chat_speed");
      }),
  );

  it.effect("ignores legacy root history and removes it on the next managed settings write", () =>
    Effect.gen(function* () {
      const { settingsPath } = fixture(
        [
          "[server]",
          'worktree_root = "/current/root"',
          'worktree_known_roots = ["/old/one", "/old/two"]',
          'git_branch_prefix = "team/"',
          "",
        ].join("\n"),
      );
      const settings = yield* makeApplicationSettings({
        environment: {},
        settingsPath,
        hostHomeDirectory: path.dirname(settingsPath),
      });
      const before = readFileSync(settingsPath);
      const snapshot = yield* settings.snapshot();
      assert.strictEqual(snapshot.managedWorktrees.worktreeRoot, "/current/root");
      assert.deepEqual(readFileSync(settingsPath), before);

      yield* settings.update({
        type: "update-managed-worktrees",
        input: { autoDeleteLimit: 21 },
      });
      const document = parseToml(readFileSync(settingsPath, "utf8")) as {
        readonly server?: Record<string, unknown>;
      };
      assert.isUndefined(document.server?.worktree_known_roots);
      assert.strictEqual(document.server?.worktree_root, "/current/root");
      assert.strictEqual(document.server?.git_branch_prefix, "team/");
    }),
  );

  it.effect("rejects a stale keybinding revision without writing", () =>
    Effect.gen(function* () {
      const { settingsPath } = fixture();
      const settings = yield* makeApplicationSettings({
        environment: {},
        settingsPath,
        hostHomeDirectory: path.dirname(settingsPath),
      });
      const prepared = yield* settings.snapshot();
      yield* settings.update({ type: "update-history", input: { retentionCount: 73 } });
      const before = readFileSync(settingsPath);
      const result = yield* Effect.result(
        settings.update(
          {
            type: "update-command-keybinding",
            commandId: "openSettings",
            input: { type: "set", keybinding: { key: "CmdOrCtrl+," } },
          },
          { expectedRevision: prepared.revision },
        ),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, ApplicationSettingsConflictError);
      }
      assert.deepEqual(readFileSync(settingsPath), before);
    }),
  );

  it.effect("persists bounded ACP Agent instance configuration without storing credentials", () =>
    Effect.gen(function* () {
      const { root, settingsPath } = fixture();
      const settings = yield* makeApplicationSettings({
        environment: {},
        settingsPath,
        hostHomeDirectory: path.dirname(settingsPath),
      });
      const updated = yield* settings.update({
        type: "update-acp-agents",
        input: {
          instances: [
            {
              id: "claude-main",
              agentDefinitionId: "claude-agent-acp",
              displayName: "Claude Agent",
              source: {
                kind: "local",
                executable: "/usr/local/bin/node",
                args: [path.join(root, "claude-agent-acp/dist/index.js")],
              },
              environment: [],
              customModels: [],
              enabled: true,
              credentials: { kind: "isolated-home", home: path.join(root, "claude-home") },
              proxy: "inherit-host",
            },
          ],
        },
      });

      assert.deepEqual(updated.acpAgents.instances, [
        {
          id: "claude-main",
          agentDefinitionId: "claude-agent-acp",
          displayName: "Claude Agent",
          source: {
            kind: "local",
            executable: "/usr/local/bin/node",
            args: [path.join(root, "claude-agent-acp/dist/index.js")],
          },
          environment: [],
          customModels: [],
          enabled: true,
          credentials: { kind: "isolated-home", home: path.join(root, "claude-home") },
          proxy: "inherit-host",
        },
      ]);
      const source = readFileSync(settingsPath, "utf8");
      assert.notInclude(source, "API_KEY");
      assert.notInclude(source, "token");
    }),
  );

  it.effect("fails closed for malformed and non-UTF-8 documents", () =>
    Effect.gen(function* () {
      for (const source of [
        "[server\n",
        'server = "not-a-table"\n',
        Uint8Array.from([0xff, 0xfe]),
        new Uint8Array(SETTINGS_DOCUMENT_MAX_BYTES + 1),
      ]) {
        const { settingsPath } = fixture(source);
        const settings = yield* makeApplicationSettings({
          environment: {},
          settingsPath,
          hostHomeDirectory: path.dirname(settingsPath),
        });
        const before = readFileSync(settingsPath);
        assert.isTrue(Result.isFailure(yield* Effect.result(settings.snapshot())));
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(
              settings.update({ type: "update-history", input: { retentionCount: 2 } }),
            ),
          ),
        );
        assert.deepEqual(readFileSync(settingsPath), before);
      }

      const { root, settingsPath } = fixture();
      const targetPath = path.join(root, "target.toml");
      writeFileSync(targetPath, "[server]\n");
      symlinkSync(targetPath, settingsPath);
      const settings = yield* makeApplicationSettings({
        environment: {},
        settingsPath,
        hostHomeDirectory: path.dirname(settingsPath),
      });
      assert.isTrue(Result.isFailure(yield* Effect.result(settings.snapshot())));
    }),
  );
});
