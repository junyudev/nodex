/* oxlint-disable nodex/no-manual-effect-runtime-in-tests, effecttsgo/strict-effect-provide -- Isolated Core and native CLI/app-server conformance cross Promise harness boundaries. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import { expect, test } from "vite-plus/test";
import type {
  ThreadForkResponse,
  ThreadGoalGetResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadRevertResponse,
  ThreadTurnsListResponse,
} from "@nodex/codex-app-server-protocol/v2";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { waitForCoreRuntimeRemoval } from "../../../scripts/scenarios/profile/isolated-profile";
import { requiredNativeExecutable } from "../../../scripts/testing/native-artifacts";
import { parseProfileConversationSnapshot } from "../../../scripts/profile-conversation-snapshot";
import {
  readCodexAppServerReleaseLock,
  resolveCodexAppServerReleaseLockPath,
} from "../../../scripts/agent-runtime-release-lock";
import { withCodexProbeSession, type CodexProbeClient } from "../../../scripts/codex-probe-session";
import { ScopedCallbackRuntime, layer } from "../app/ScopedCallbackRuntime";
import { initializeStandaloneDataAuthority } from "./index";
import {
  PastedTextAttachmentManager,
  ThreadGoalAttachmentDirectoryManager,
  readThreadGoalEditableObjective,
} from "../thread-goal-attachments";

const exec = promisify(execFile);
const stamp = "2026-09-22T00:00:00Z";

// This is deliberately a native storage fixture: Core metadata is seeded through public operations.
const writeHistory = async (
  home: string,
  threadId: string,
  cwd: string,
  paginated: boolean,
): Promise<string> => {
  const file = join(home, "sessions/2026/09/22", `rollout-2026-09-22T00-00-00-${threadId}.jsonl`);
  const rows = [
    {
      type: "session_meta",
      payload: {
        id: threadId,
        session_id: threadId,
        timestamp: stamp,
        cwd,
        originator: "nodex-profile-test",
        cli_version: "0.155.0",
        source: "cli",
        model_provider: "openai",
        history_mode: paginated ? "paginated" : "legacy",
      },
    },
    ...[
      ["fixture-turn", "Retain this conversation"],
      ["discarded-turn", "Discard this later turn"],
    ].flatMap(([turnId, text]) => [
      {
        type: "event_msg",
        payload: { type: "task_started", turn_id: turnId, model_context_window: 128000 },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          thread_id: threadId,
          turn_id: turnId,
          item: {
            type: "UserMessage",
            id: `${turnId}-message`,
            content: [{ type: "text", text, text_elements: [] }],
          },
          completed_at_ms: 1,
        },
      },
      {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: turnId, last_agent_message: null },
      },
    ]),
  ];
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    rows
      .map((row, ordinal) => JSON.stringify({ timestamp: stamp, ordinal, ...row }) + "\n")
      .join(""),
  );
  return file;
};

const clone = async (source: string, target: string, extra: string[] = []) => {
  const result = await exec(
    requiredNativeExecutable("cli"),
    ["--json", "profile", "clone", "--from", source, "--to", target, ...extra],
    { maxBuffer: 1024 * 1024 },
  );
  return parseProfileConversationSnapshot(JSON.parse(result.stdout).result.conversations);
};

const withNative = <A>(
  binaryPath: string,
  home: string,
  use: (client: CodexProbeClient) => Promise<A>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const callbacks = yield* ScopedCallbackRuntime;
      return yield* withCodexProbeSession(
        callbacks,
        {
          binaryPath,
          args: ["app-server"],
          env: { PATH: process.env.PATH, HOME: dirname(home), CODEX_HOME: home },
          expectedCodexHome: home,
          clientInfo: {
            name: "nodex-profile-clone-test",
            title: "Profile Clone Test",
            version: "1",
          },
        },
        use,
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

const verifyClone = async (binaryPath?: string) => {
  if (binaryPath) {
    const lock = readCodexAppServerReleaseLock(resolveCodexAppServerReleaseLockPath(resolve(".")));
    expect((await exec(binaryPath, ["--version"])).stdout.trim()).toBe(
      `codex-cli ${lock.appServerRuntimeVersion}`,
    );
  }
  await withCoreScenario({ scenarioId: "nfm-code-block-actions" }, async (context) => {
    const { profile, manifest } = context;
    const parentId = randomUUID();
    const parentPath = await writeHistory(
      profile.codexHome,
      parentId,
      profile.initialProjectsDirectory,
      Boolean(binaryPath),
    );
    let selectedId: string = parentId;
    let selectedFile = basename(parentPath);
    const attachmentsRoot = join(profile.codexHome, "attachments");
    const pastedText = await new PastedTextAttachmentManager({ attachmentsRoot }).createRawSource({
      text: "Retain this managed text attachment",
    });
    const goal = await new ThreadGoalAttachmentDirectoryManager({
      attachmentsRoot,
    }).materializeDraft({
      objective: "A".repeat(4001),
      pastedTextAttachments: [{ text: "Goal attachment contents" }],
      imageAttachments: [],
    });
    const editableGoal = await readThreadGoalEditableObjective({
      attachmentsRoot,
      objective: goal.objective,
    });
    if (binaryPath) {
      selectedId = await withNative(binaryPath, profile.codexHome, async (client) => {
        const source = await client.request<ThreadReadResponse>("thread/read", {
          threadId: parentId,
        });
        expect(source.thread.historyMode).toBe("paginated");
        const fork = await client.request<ThreadForkResponse>("thread/fork", {
          threadId: parentId,
          excludeTurns: true,
          deferGoalContinuation: true,
        });
        const original = await client.request<ThreadTurnsListResponse>("thread/turns/list", {
          threadId: fork.thread.id,
          itemsView: "full",
        });
        expect(original.data).toHaveLength(2);
        expect(original.data[0]?.items).toHaveLength(1);
        await client.request("thread/name/set", {
          threadId: fork.thread.id,
          name: "Copied conversation",
        });
        await client.request("thread/archive", { threadId: parentId });
        return fork.thread.id;
      });
      selectedFile = await withNative(binaryPath, profile.codexHome, async (client) => {
        await client.request("thread/resume", { threadId: selectedId, excludeTurns: true });
        const reverted = await client.request<ThreadRevertResponse>("thread/revert", {
          threadId: selectedId,
          beforeTurnId: "discarded-turn",
        });
        expect(reverted.thread.id).toBe(selectedId);
        expect(reverted.thread.path).toBeTruthy();
        await client.request("thread/goal/set", {
          threadId: selectedId,
          objective: goal.objective,
          status: "paused",
        });
        return basename(reverted.thread.path!);
      });
    }
    const pageId = Object.values(manifest.pageIdsByKey)[0]!;
    const link = await context.seed.createRelatedChat({
      projectId: manifest.projectId,
      initialPageIds: [pageId],
      noThreadFallbackTitle: "Copied conversation",
      thread: {
        threadId: selectedId,
        threadName: "Copied conversation",
        threadPreview: "Retain this conversation",
        statusType: "idle",
        statusActiveFlags: [],
        unread: false,
      },
    });
    await context.client.administrationApply({
      operationId: randomUUID(),
      intent: {
        kind: "create_backup",
        label: "Profile clone",
        include_assets: true,
        trigger: "manual",
      },
    });
    const target = join(profile.runRoot, "cloned-profile");
    const missingTarget = join(profile.runRoot, "missing-profile");
    const hiddenAgent = join(profile.runRoot, "hidden-agent");
    await rename(profile.codexHome, hiddenAgent);
    try {
      await expect(clone(profile.nodexHome, missingTarget)).rejects.toThrow(
        "no recoverable native history",
      );
      expect(await readdir(profile.runRoot)).not.toContain("missing-profile");
      expect(
        (await readdir(profile.runRoot)).filter((name) => name.startsWith(".profile-clone-")),
      ).toEqual([]);
      const partial = await clone(profile.nodexHome, missingTarget, [
        "--allow-missing-conversations",
      ]);
      expect(partial.missingThreadIds).toEqual([selectedId]);
      expect(partial.capturedThreadCount).toBe(0);
    } finally {
      await rename(hiddenAgent, profile.codexHome);
      await rm(missingTarget, { recursive: true, force: true });
    }
    const receipt = await clone(profile.nodexHome, target);
    expect(receipt.requiredThreadCount).toBe(1);
    expect(receipt.capturedThreadCount).toBe(1);
    expect(receipt.missingThreadIds).toEqual([]);
    if (!binaryPath)
      expect(
        await readFile(
          join(target, "agent", parentPath.slice(profile.codexHome.length + 1)),
          "utf8",
        ),
      ).toBe(await readFile(parentPath, "utf8"));
    await context.withStoppedCore(async () => {
      const hidden = join(profile.runRoot, "source-unavailable");
      await rename(profile.nodexHome, hidden);
      try {
        const copiedAttachmentsRoot = join(target, "agent", "attachments");
        const copiedTextPath = pastedText.file.path.replace(attachmentsRoot, copiedAttachmentsRoot);
        expect(
          await new PastedTextAttachmentManager({
            attachmentsRoot: copiedAttachmentsRoot,
          }).readRawSource({ ...pastedText.file, path: copiedTextPath, fsPath: copiedTextPath }),
        ).toBe("Retain this managed text attachment");
        const copied = await initializeStandaloneDataAuthority({
          buildId: "profile-clone-test",
          isPackaged: false,
          nodexHome: target,
        });
        try {
          const chats = await copied.rootClient.forProject(manifest.projectId).workspaceRead({
            kind: "page_chat_window",
            page_access_project_id: manifest.projectId,
            page_id: pageId,
            include_archived: false,
            window: { after: null, first: 50 },
          });
          expect(chats.value).toMatchObject({
            chats: { items: [{ session_id: link.sessionId, thread_id: selectedId }] },
          });
        } finally {
          await copied.rootClient.shutdown();
          await waitForCoreRuntimeRemoval(target);
        }
        if (binaryPath)
          await withNative(binaryPath, join(target, "agent"), async (client) => {
            const read = await client.request<ThreadReadResponse>("thread/read", {
              threadId: selectedId,
            });
            expect(read.thread.id).toBe(selectedId);
            expect(read.thread.name).toBe("Copied conversation");
            expect(read.thread.path?.startsWith(join(target, "agent"))).toBe(true);
            expect(basename(read.thread.path!)).toBe(selectedFile);
            const copiedGoal = await client.request<ThreadGoalGetResponse>("thread/goal/get", {
              threadId: selectedId,
            });
            expect(copiedGoal.goal?.status).toBe("paused");
            expect(
              await readThreadGoalEditableObjective({
                attachmentsRoot: copiedAttachmentsRoot,
                objective: copiedGoal.goal!.objective,
              }),
            ).toBe(editableGoal.replaceAll(attachmentsRoot, copiedAttachmentsRoot));
            const resumed = await client.request<ThreadResumeResponse>("thread/resume", {
              threadId: selectedId,
              excludeTurns: true,
            });
            expect(resumed.thread.id).toBe(selectedId);
            expect(resumed.thread.path?.startsWith(join(target, "agent"))).toBe(true);
            const turns = await client.request<ThreadTurnsListResponse>("thread/turns/list", {
              threadId: selectedId,
              itemsView: "full",
            });
            expect(turns.data).toHaveLength(1);
            expect(turns.data[0]?.items).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: "userMessage",
                  content: [
                    expect.objectContaining({ type: "text", text: "Retain this conversation" }),
                  ],
                }),
              ]),
            );
          });
      } finally {
        await rename(hidden, profile.nodexHome);
      }
    });
    await rm(target, { recursive: true, force: true });
  });
};

test(
  "Profile clone publishes conversation closure and preserves Core Session links",
  () => verifyClone(),
  90_000,
);

test.runIf(Boolean(process.env.NODEX_TEST_PROFILE_CODEX_BINARY))(
  "the pinned native runtime restores inherited history after the source Profile is removed",
  () => verifyClone(process.env.NODEX_TEST_PROFILE_CODEX_BINARY),
  120_000,
);
