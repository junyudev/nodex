import { describe, expect, test } from "vite-plus/test";

import type { CodexConversationTurn } from "../../lib/types";
import {
  createSessionFirstSubmissionOwner,
  hasDurableCanonicalFirstSubmission,
} from "./session-first-submission-owner";

const LAUNCH_ID = "01991e60-b800-7000-8000-000000000001";
const MESSAGE_ID = "01991e60-b800-7000-8000-000000000002";

function canonicalTurn(clientUserMessageId: string): CodexConversationTurn {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    status: "inProgress",
    itemIds: ["user_1"],
    items: [
      {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "user_1",
        type: "userMessage",
        kind: "userMessage",
        semanticKind: "userMessage",
        role: "user",
        status: "completed",
        markdownText: "Trace the launch.",
        rawItem: {
          id: "user_1",
          type: "userMessage",
          clientId: clientUserMessageId,
          content: [],
        },
        createdAt: 10,
        updatedAt: 10,
      },
    ],
  };
}

describe("SessionFirstSubmissionOwner", () => {
  test("publishes the submitted user row synchronously and yields to its canonical row", () => {
    const ids = [LAUNCH_ID, MESSAGE_ID];
    const owner = createSessionFirstSubmissionOwner({
      createId: () => ids.shift() ?? "unexpected-id",
      now: () => 10,
    });
    let notifications = 0;
    owner.subscribe(() => {
      notifications += 1;
    });

    const handle = owner.begin({
      backend: "codex",
      originProjectId: "project_1",
      originSessionId: "session_1",
      prompt: "Trace the launch.",
    });

    expect(handle).toEqual({
      launchId: LAUNCH_ID,
      clientUserMessageId: MESSAGE_ID,
      originProjectId: "project_1",
      originSessionId: "session_1",
    });
    expect(notifications).toBe(1);

    const provisional = owner.projectTurns(
      {
        projectId: "project_1",
        sessionId: "session_1",
        threadId: null,
      },
      [],
    );
    expect(provisional).toHaveLength(1);
    expect(provisional[0]?.items[0]?.markdownText).toBe("Trace the launch.");
    expect((provisional[0]?.items[0]?.rawItem as { clientId?: string } | undefined)?.clientId).toBe(
      MESSAGE_ID,
    );

    const canonical = canonicalTurn(MESSAGE_ID);
    const optimistic = { ...canonical, turnId: null };
    expect(hasDurableCanonicalFirstSubmission([optimistic], MESSAGE_ID)).toBe(false);
    expect(
      owner.projectTurns(
        {
          projectId: "project_1",
          sessionId: "session_1",
          threadId: "thread_1",
        },
        [optimistic],
      ),
    ).toEqual([optimistic]);
    expect(hasDurableCanonicalFirstSubmission([canonical], MESSAGE_ID)).toBe(true);
    const handedOff = owner.projectTurns(
      {
        projectId: "project_1",
        sessionId: "session_1",
        threadId: "thread_1",
      },
      [canonical],
    );
    expect(handedOff).toEqual([canonical]);
  });

  test("retargets one presentation without leaving a second row on its origin Session", () => {
    const ids = [LAUNCH_ID, MESSAGE_ID];
    const owner = createSessionFirstSubmissionOwner({
      createId: () => ids.shift() ?? "unexpected-id",
      now: () => 10,
    });
    const handle = owner.begin({
      backend: "codex",
      originProjectId: "project_1",
      originSessionId: "session_1",
      prompt: "Move once.",
    });

    owner.update(handle.launchId, {
      targetProjectId: "project_2",
      targetSessionId: "session_2",
      phase: "startingThread",
    });

    expect(
      owner.projectTurns({ projectId: "project_1", sessionId: "session_1", threadId: null }, []),
    ).toHaveLength(0);
    expect(
      owner.projectTurns({ projectId: "project_2", sessionId: "session_2", threadId: null }, []),
    ).toHaveLength(1);
  });

  test("keeps failed submissions recoverable and ignores stale progress", () => {
    const ids = [LAUNCH_ID, MESSAGE_ID];
    const owner = createSessionFirstSubmissionOwner({
      createId: () => ids.shift() ?? "unexpected-id",
      now: () => 10,
    });
    const handle = owner.begin({
      backend: "codex",
      originProjectId: "project_1",
      originSessionId: "session_1",
      prompt: "Keep the failure visible.",
    });
    owner.update(handle.launchId, { phase: "adoptingOwner", threadId: "thread_1" });
    const adoptingSnapshot = owner.getSnapshot();
    owner.update(handle.launchId, { phase: "startingThread" });
    expect(owner.getSnapshot()).toBe(adoptingSnapshot);

    owner.fail(handle.launchId, {
      stage: "adoptingOwner",
      message: "Owner adoption failed",
    });
    const failed = owner.projectTurns(
      { projectId: "project_1", sessionId: "session_1", threadId: "thread_1" },
      [],
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.status).toBe("failed");
    expect(failed[0]?.errorMessage).toBe("Owner adoption failed");

    owner.update(handle.launchId, { phase: "startingTurn" });
    expect(owner.getSnapshot().submissions[0]?.phase).toBe("failed");
    owner.complete(handle.launchId);
    expect(owner.getSnapshot().submissions).toHaveLength(0);
  });

  test("gives an explicit retry new identities and ignores the superseded attempt", () => {
    const ids = [
      LAUNCH_ID,
      MESSAGE_ID,
      "01991e60-b800-7000-8000-000000000003",
      "01991e60-b800-7000-8000-000000000004",
    ];
    const owner = createSessionFirstSubmissionOwner({
      createId: () => ids.shift() ?? "unexpected-id",
      now: () => 10,
    });
    const failed = owner.begin({
      backend: "codex",
      originProjectId: "project_1",
      originSessionId: "session_1",
      prompt: "Retry me.",
    });
    owner.update(failed.launchId, {
      targetProjectId: "project_1",
      targetSessionId: "session_2",
    });
    owner.fail(failed.launchId, {
      stage: "startingThread",
      message: "Thread start failed",
    });

    const retry = owner.begin({
      backend: "codex",
      originProjectId: "project_1",
      originSessionId: "session_2",
      prompt: "Retry me.",
    });
    owner.update(failed.launchId, { phase: "startingTurn", threadId: "stale-thread" });

    expect(retry.launchId).not.toBe(failed.launchId);
    expect(retry.clientUserMessageId).not.toBe(failed.clientUserMessageId);
    expect(owner.getSnapshot().submissions).toEqual([
      expect.objectContaining({
        launchId: retry.launchId,
        clientUserMessageId: retry.clientUserMessageId,
        phase: "accepted",
      }),
    ]);
  });

  test("dispose releases pending submissions and subscriptions", () => {
    const ids = [LAUNCH_ID, MESSAGE_ID, "new-launch", "new-message"];
    const owner = createSessionFirstSubmissionOwner({
      createId: () => ids.shift() ?? "unexpected-id",
      now: () => 10,
    });
    let notifications = 0;
    owner.subscribe(() => {
      notifications += 1;
    });
    owner.begin({
      backend: "codex",
      originProjectId: "project_1",
      originSessionId: "session_1",
      prompt: "Dispose me.",
    });
    owner.dispose();
    owner.begin({
      backend: "codex",
      originProjectId: "project_2",
      originSessionId: "session_2",
      prompt: "No stale subscriber.",
    });

    expect(notifications).toBe(1);
    expect(owner.getSnapshot().submissions).toHaveLength(1);
  });
});
