import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  NATIVE_AUTOMATION_RUN_LIMIT,
  nativeAutomationConversationIds,
} from "../../../../shared/native-automation-import";
import { claudeDesktopUserDataHomes, readClaudeNativeAutomations } from "./claude";
import { readCodexNativeAutomations } from "./codex";

const fixtures = new URL("./fixtures/", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, fixtures), "utf8");
const temporaryRoot = Effect.acquireRelease(
  Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), "nodex-native-automations-")))),
  (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
);

function legacyFixture(home: string, id: string) {
  const dir = join(home, "automations", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "automation.toml"),
    fixture("automation.toml").replace("legacy-only", id),
  );
  return dir;
}

it.effect("uses committed Codex data, links runs, and respects scope and legacy tombstones", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = yield* temporaryRoot;
      for (const id of ["legacy-only", "daily-old", "deleted", "other"]) legacyFixture(home, id);
      const daily = legacyFixture(home, "daily");
      copyFileSync(new URL("memory.md", fixtures), join(daily, "memory.md"));
      mkdirSync(join(home, "sqlite"));
      // Keep the writer open so the reader must see the committed WAL.
      using writer = new DatabaseSync(join(home, "sqlite", "codex.db"));
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      writer.exec(fixture("codex.sql"));
      const result = yield* readCodexNativeAutomations({
        codexHome: home,
        owner: { accountId: "account", userId: "user", installationId: "installation" },
      });
      expect(result.issues).toEqual([]);
      expect(result.candidates).toMatchObject([
        {
          sourceAutomationId: "daily",
          sourceHome: home,
          name: "Database task",
          sourceStatus: "active",
          executionEnvironment: "worktree",
          localEnvironmentConfigPath: "/work/environment.toml",
          notificationPolicy: "failed_runs_only",
          folders: ["/work/project"],
          conversationSource: { backendKind: "codex", nativeHome: home },
          memory: fixture("memory.md"),
          runs: [
            { nativeSessionId: "run-newest", createdAt: 2, updatedAt: 12, archived: false },
            { nativeSessionId: "run-earlier", createdAt: 1, updatedAt: 15, archived: true },
          ],
        },
        {
          sourceAutomationId: "beat",
          kind: "heartbeat",
          heartbeatTarget: { nativeSessionId: "native-target" },
          runs: [],
        },
        {
          sourceAutomationId: "legacy-only",
          sourceStatus: "paused",
          runs: [{ nativeSessionId: "legacy-run" }],
        },
      ]);
      expect(nativeAutomationConversationIds(result.candidates).get("codex")?.get(home)).toEqual(
        new Set(["run-newest", "run-earlier", "legacy-run"]),
      );

      const insert = writer.prepare(
        "INSERT INTO automation_runs VALUES (?, 'daily', 'PENDING_REVIEW', NULL, NULL, ?, ?)",
      );
      for (let index = 0; index < NATIVE_AUTOMATION_RUN_LIMIT; index++) {
        insert.run(`extra-${index}`, 100 + index, 100 + index);
      }
      const capped = yield* readCodexNativeAutomations({ codexHome: home });
      expect(
        capped.candidates.find((candidate) => candidate.sourceAutomationId === "daily")?.runs,
      ).toHaveLength(NATIVE_AUTOMATION_RUN_LIMIT);
      expect(capped.issues).toContainEqual({
        sourceHome: home,
        store: "codex-runs",
        reason: "limit",
      });
    }),
  ),
);

it.effect("uses legacy Codex tasks when the production database is absent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = yield* temporaryRoot;
      legacyFixture(home, "legacy-only");
      mkdirSync(join(home, "sqlite"));
      writeFileSync(join(home, "sqlite", "codex-dev.db"), "development data");
      const result = yield* readCodexNativeAutomations({ codexHome: home });
      expect(result.candidates.map(({ sourceAutomationId }) => sourceAutomationId)).toEqual([
        "legacy-only",
      ]);
      expect(result.issues).toContainEqual({
        sourceHome: home,
        store: "codex-database",
        reason: "missing",
      });

      writeFileSync(join(home, "sqlite", "codex.db"), "unreadable database");
      const unreadable = yield* readCodexNativeAutomations({ codexHome: home });
      expect(unreadable).toEqual({
        candidates: [],
        issues: [{ sourceHome: home, store: "codex-database", reason: "unreadable" }],
      });
    }),
  ),
);

it.effect("keeps Claude organization and CLI profile identity and links only task runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const userDataHome = join(root, "Claude");
      const nativeHome = join(root, ".claude");
      const org = join(userDataHome, "claude-code-sessions", "account", "org");
      const otherOrg = join(userDataHome, "claude-code-sessions", "account", "other-org");
      mkdirSync(org, { recursive: true });
      mkdirSync(otherOrg, { recursive: true });
      mkdirSync(nativeHome);
      const skill = join(nativeHome, "scheduled-tasks", "review", "SKILL.md");
      mkdirSync(join(nativeHome, "scheduled-tasks", "review"), { recursive: true });
      copyFileSync(new URL("SKILL.md", fixtures), skill);
      const document = JSON.parse(fixture("scheduled-tasks.json")) as {
        scheduledTasks: { id: string; filePath: string }[];
      };
      for (const task of document.scheduledTasks) {
        task.filePath = task.id === "unreadable-skill" ? join(root, "missing", "SKILL.md") : skill;
      }
      writeFileSync(join(org, "scheduled-tasks.json"), JSON.stringify(document));
      writeFileSync(join(otherOrg, "scheduled-tasks.json"), "broken JSON");

      const earlierRun = JSON.parse(fixture("local_fixture.json")) as Record<string, unknown>;
      copyFileSync(new URL("local_fixture.json", fixtures), join(org, "local_earlier.json"));
      writeFileSync(
        join(org, "local_newest.json"),
        JSON.stringify({
          ...earlierRun,
          cliSessionId: "newest-cli-id",
          createdAt: 2000,
          lastActivityAt: 2100,
          isArchived: false,
        }),
      );
      writeFileSync(join(org, "local_pending.json"), JSON.stringify({ scheduledTaskId: "daily" }));
      writeFileSync(
        join(otherOrg, "local_other.json"),
        JSON.stringify({ ...earlierRun, cliSessionId: "other-org-id" }),
      );
      const result = yield* readClaudeNativeAutomations({
        userDataHome,
        nativeHome,
        instanceConfigId: "claude-profile",
      });
      expect(result.candidates).toMatchObject([
        {
          sourceAutomationId: "daily",
          sourceHome: org,
          name: "Review incoming work",
          prompt: "Check the inbox and write a short summary.",
          model: "fixture-model",
          folders: ["/work/project"],
          additionalFolders: ["/shared/references"],
          executionEnvironment: "worktree",
          sourceStatus: "active",
          conversationSource: {
            backendKind: "claude",
            instanceConfigId: "claude-profile",
            nativeHome,
          },
          schedule: {
            kind: "rrule",
            rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=15;BYSECOND=0;BYDAY=MO,TU,WE,TH,FR",
          },
          runs: [
            { nativeSessionId: "newest-cli-id", archived: false },
            { nativeSessionId: earlierRun.cliSessionId, title: "Earlier run", archived: true },
          ],
        },
        {
          sourceAutomationId: "one-shot",
          model: "fallback-model",
          sourceStatus: "paused",
          schedule: { kind: "unsupported", reason: "one-shot" },
        },
        { sourceAutomationId: "manual", schedule: { kind: "unsupported", reason: "manual" } },
      ]);
      expect(result.issues).toEqual([
        { sourceHome: org, store: "claude-skill", reason: "missing" },
        { sourceHome: otherOrg, store: "claude-tasks", reason: "invalid" },
      ]);
    }),
  ),
);

it("resolves Claude Desktop data directories with the host's path rules", () => {
  expect(
    claudeDesktopUserDataHomes({
      homeDirectory: "/Users/fixture",
      platform: "darwin",
      environment: {},
    }),
  ).toEqual([
    "/Users/fixture/Library/Application Support/Claude",
    "/Users/fixture/Library/Application Support/Claude-3p",
  ]);
  expect(
    claudeDesktopUserDataHomes({
      homeDirectory: "C:/Users/Fixture",
      platform: "win32",
      environment: { AppData: "C:/Roaming", LOCALAPPDATA: "C:/Local" },
    }),
  ).toEqual(["C:\\Roaming\\Claude", "C:\\Local\\Claude-3p"]);
  expect(
    claudeDesktopUserDataHomes({
      homeDirectory: "/home/fixture",
      platform: "linux",
      environment: { XDG_CONFIG_HOME: "/tmp/config" },
    }),
  ).toEqual(["/tmp/config/Claude", "/tmp/config/Claude-3p"]);
});
