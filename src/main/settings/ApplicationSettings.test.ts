import { assert, it } from "@effect/vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  it.effect("serializes concurrent setting-family mutations and preserves unknown TOML", () =>
    Effect.gen(function* () {
      const { settingsPath } = fixture('[plugin]\nname = "keep"\n\n[server]\nunknown = "keep"\n');
      const settings = yield* makeApplicationSettings({ environment: {}, settingsPath });

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
      const settings = yield* makeApplicationSettings({ environment: {}, settingsPath });
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
      const settings = yield* makeApplicationSettings({ environment: {}, settingsPath });
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

  it.effect("fails closed for malformed and non-UTF-8 documents", () =>
    Effect.gen(function* () {
      for (const source of [
        "[server\n",
        'server = "not-a-table"\n',
        Uint8Array.from([0xff, 0xfe]),
        new Uint8Array(SETTINGS_DOCUMENT_MAX_BYTES + 1),
      ]) {
        const { settingsPath } = fixture(source);
        const settings = yield* makeApplicationSettings({ environment: {}, settingsPath });
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
      const settings = yield* makeApplicationSettings({ environment: {}, settingsPath });
      assert.isTrue(Result.isFailure(yield* Effect.result(settings.snapshot())));
    }),
  );
});
