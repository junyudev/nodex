import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

const HOUR_MS = 60 * 60 * 1000;

const SUBJECTS = [
  "the sync worker's retry backoff",
  "flaky login tests on CI",
  "the billing webhook handler",
  "dark mode tokens in Settings",
  "the search index rebuild",
  "first-run onboarding copy",
  "the Postgres connection pool",
  "the image upload size limit",
  "keyboard navigation in the sidebar",
  "the release checklist",
  "Inbox 的排序和分组",
  "夜间构建失败的通知",
  "文档站的导航结构",
];
const ACTIONS = ["Fix", "Refactor", "Investigate", "Add tests for", "Simplify", "Document", "排查"];

/** Most of a person's work sits in a few folders, with a long tail of one-off worktrees. */
const FOLDERS = [
  "repo/atlas",
  "repo/atlas",
  "repo/atlas",
  "repo/atlas",
  "repo/harbor",
  "repo/harbor",
  "repo/lumen-docs",
  "repo/atlas/.worktrees/search-index",
  "repo/orbit-api",
  "sandbox/sqlite-spike",
];
/** Exists in the history but no longer on disk. */
const REMOVED_FOLDER = "repo/retired-service";

export const conversationImportHistoryCounts = { codex: 240, claude: 70 } as const;

/** One conversation deep in Codex history, read only past its first pages. */
export const OLDEST_CODEX_TITLE = "Migrate the billing ledger to double entry";
/** Two Claude conversations reachable only by separate searches. */
export const CLAUDE_RELEASE_TITLE = "Draft the harbor release notes";
export const CLAUDE_MIGRATION_TITLE = "整理数据迁移计划";

const nativeId = (kind: number, index: number) =>
  `019f${kind.toString(16).padStart(4, "0")}-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;

const generatedTitle = (index: number) =>
  `${ACTIONS[index % ACTIONS.length]} ${SUBJECTS[index % SUBJECTS.length]}`;

/**
 * History as Codex and Claude Code leave it on disk: long enough to span several pages of each,
 * across folders of very different sizes. Conversations end an hour apart, Codex and Claude
 * interleaved, so every order a test states is exact.
 */
export function writeConversationImportHistory(input: {
  readonly codexHome: string;
  readonly claudeHome: string;
  /** Where the folders live; the launched app's home makes them read as `~/repo/…`. */
  readonly root: string;
  readonly nowMs: number;
}): void {
  const folderAt = (index: number) =>
    path.join(
      input.root,
      index % 37 === 36 ? REMOVED_FOLDER : (FOLDERS[index % FOLDERS.length] ?? REMOVED_FOLDER),
    );
  for (const folder of new Set(FOLDERS))
    mkdirSync(path.join(input.root, folder), { recursive: true });

  const sessions = path.join(input.codexHome, "sessions", "2026", "11", "07");
  mkdirSync(sessions, { recursive: true });
  for (let index = 0; index < conversationImportHistoryCounts.codex; index += 1) {
    const at = input.nowMs - (index + 1) * HOUR_MS;
    const timestamp = new Date(at).toISOString();
    const id = nativeId(1, index);
    const file = path.join(
      sessions,
      `rollout-${timestamp.replace(/\.\d+Z$/u, "").replaceAll(":", "-")}-${id}.jsonl`,
    );
    const title =
      index === conversationImportHistoryCounts.codex - 1
        ? OLDEST_CODEX_TITLE
        : generatedTitle(index);
    writeFileSync(
      file,
      [
        {
          timestamp,
          type: "session_meta",
          payload: {
            id,
            timestamp,
            cwd: folderAt(index),
            originator: "codex_cli_rs",
            cli_version: "0.163.0",
            source: "cli",
            model_provider: "openai",
          },
        },
        {
          timestamp,
          type: "event_msg",
          payload: {
            type: "user_message",
            message: title,
            images: [],
            local_images: [],
            text_elements: [],
            kind: "plain",
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    utimesSync(file, new Date(at), new Date(at));
  }

  for (let index = 0; index < conversationImportHistoryCounts.claude; index += 1) {
    const at = input.nowMs - (index * 3 + 1.5) * HOUR_MS;
    const timestamp = new Date(at).toISOString();
    const id = nativeId(2, index);
    const cwd = folderAt(index + 3);
    const project = path.join(input.claudeHome, "projects", cwd.replace(/[^a-zA-Z0-9]/gu, "-"));
    mkdirSync(project, { recursive: true });
    const file = path.join(project, `${id}.jsonl`);
    const title =
      index === 40
        ? CLAUDE_RELEASE_TITLE
        : index === 65
          ? CLAUDE_MIGRATION_TITLE
          : generatedTitle(index + 5);
    const userId = nativeId(3, index);
    writeFileSync(
      file,
      [
        {
          type: "user",
          uuid: userId,
          parentUuid: null,
          sessionId: id,
          cwd,
          timestamp,
          message: { role: "user", content: [{ type: "text", text: title }] },
        },
        {
          type: "assistant",
          uuid: nativeId(4, index),
          parentUuid: userId,
          sessionId: id,
          cwd,
          timestamp,
          message: {
            role: "assistant",
            model: "claude-opus-5",
            content: [{ type: "text", text: "Done." }],
          },
        },
        { type: "custom-title", customTitle: title, sessionId: id },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    utimesSync(file, new Date(at), new Date(at));
  }
}
