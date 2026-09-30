import { assert, it } from "@effect/vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe } from "vite-plus/test";
import {
  ApplicationSettingsConflictError,
  make as makeApplicationSettings,
} from "./ApplicationSettings";
import { SETTINGS_DOCUMENT_MAX_BYTES } from "./settings-document";

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
  it.effect(
    "retains the existing Profile conversation home but leaves empty legacy directories unpinned",
    () =>
      Effect.gen(function* () {
        const { root, settingsPath } = fixture('[plugin]\nname = "keep"\n');
        const legacyHome = path.join(root, "agent");
        mkdirSync(path.join(legacyHome, "sessions"), { recursive: true });
        const empty = yield* makeApplicationSettings({
          environment: {},
          hostHomeDirectory: path.join(root, "user"),
          settingsPath,
        });
        const emptySnapshot = yield* empty.snapshot();
        assert.strictEqual(emptySnapshot.codexHome.source, "default");
        assert.strictEqual(
          emptySnapshot.codexHome.resolvedHomePath,
          path.join(root, "user", ".codex"),
        );
        const before = readFileSync(settingsPath);
        writeFileSync(
          path.join(legacyHome, "sessions", "rollout-retained.jsonl"),
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
        const retained = yield* makeApplicationSettings({
          environment: {},
          hostHomeDirectory: path.join(root, "user"),
          settingsPath,
        });
        const snapshot = yield* retained.snapshot();
        const canonicalLegacyHome = realpathSync(legacyHome);
        assert.strictEqual(snapshot.codexHome.activeHomePath, canonicalLegacyHome);
        assert.strictEqual(snapshot.codexHome.source, "settings");
        assert.isFalse(snapshot.codexHome.restartRequired);
        const document = parseToml(readFileSync(settingsPath, "utf8")) as {
          server: { codex_home: string };
          plugin: { name: string };
        };
        assert.strictEqual(document.server.codex_home, canonicalLegacyHome);
        assert.strictEqual(document.plugin.name, "keep");
        assert.notDeepEqual(readFileSync(settingsPath), before);
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
          activeHomePath: "/host/native-codex",
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
          activeHomePath: "/host/native-codex",
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
              packageRoot: path.join(root, "claude-agent-acp"),
              nodeExecutable: "/usr/local/bin/node",
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
          packageRoot: path.join(root, "claude-agent-acp"),
          nodeExecutable: "/usr/local/bin/node",
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
