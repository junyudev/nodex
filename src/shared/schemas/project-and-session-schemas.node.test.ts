import { describe, expect, it, test } from "vite-plus/test";
import { createBoundedOperationId } from "../operation-identity";
import { decodeInboxAgentBinding, encodeInboxAgentBinding } from "../inbox";
import {
  InboxEditInputSchema,
  InboxExecutionSelectionSchema,
  InboxPreparedConfirmationSchema,
  InboxSendInputSchema,
  InboxSuggestionRequestInputSchema,
  MAX_INBOX_TITLE_LENGTH,
  UpdateInboxSettingsInputSchema,
} from "./inbox";
import { parseWorkbenchProjectionTabConfig } from "./project-sessions";
import {
  ProjectCreateInputSchema,
  ProjectUpdateCommandInputSchema,
  ProjectUpdateInputSchema,
} from "./projects";
import { ProjectSessionSummaryWindowInputSchema } from "./session-order";

describe("inbox", () => {
  const basis = { pageId: "page-a", contentHash: "a".repeat(64) };

  describe("Inbox boundary contracts", () => {
    it("accepts an optional boolean preference for showing the Page beside new chats", () => {
      expect(UpdateInboxSettingsInputSchema.parse({})).toEqual({});
      for (const showPageBesideNewChats of [true, false]) {
        const input = { showPageBesideNewChats };
        expect(UpdateInboxSettingsInputSchema.parse(input)).toEqual(input);
      }
      expect(
        UpdateInboxSettingsInputSchema.safeParse({ showPageBesideNewChats: "false" }).success,
      ).toBe(false);
      expect(
        UpdateInboxSettingsInputSchema.safeParse({ showPageBesideNewChats: null }).success,
      ).toBe(false);
    });

    it("accepts an optional worktree choice for a new chat, and reads a selection without one as a worktree", () => {
      expect(UpdateInboxSettingsInputSchema.parse({ newChatsUseWorktrees: false })).toEqual({
        newChatsUseWorktrees: false,
      });
      const modelSelection = { instanceId: "codex", model: "reviewed-model" };
      expect(
        InboxExecutionSelectionSchema.parse({ modelSelection, interactionMode: "default" })
          .worktree,
      ).toBe(true);
      expect(
        InboxExecutionSelectionSchema.parse({
          modelSelection,
          interactionMode: "default",
          worktree: false,
        }).worktree,
      ).toBe(false);
    });

    it("keeps an already prepared confirmation unchanged when replayed", () => {
      const prepared = {
        kind: "direct",
        storeEpoch: "epoch-a",
        operationId: createBoundedOperationId("inbox.dispatch"),
        proposalId: "proposal-a",
        sessionId: "session-a",
        pageIds: [basis.pageId],
        basis: [basis],
        action: { type: "new_chat", projectId: null, prompt: "Research only; do not change code." },
        executionSelection: {
          modelSelection: { instanceId: "codex", model: "reviewed-model" },
          interactionMode: "plan",
        },
      };
      const first = InboxPreparedConfirmationSchema.parse(prepared);
      expect(InboxPreparedConfirmationSchema.parse(JSON.parse(JSON.stringify(first)))).toEqual(
        first,
      );
      // A saved decision with no model, additions, or skills still replays.
      expect(first.action).toEqual({
        type: "new_chat",
        projectId: null,
        prompt: "Research only; do not change code.",
        agent: null,
        additions: [],
        skills: [],
      });
    });

    it("rejects a capture without a replayable operation identity and measures UTF-8 bytes", () => {
      const capture = {
        scope: { kind: "library" },
        operationId: createBoundedOperationId("inbox.send"),
        pageId: "page-a",
        documentId: "document-a",
        issuedAt: Date.now(),
        storeEpoch: "epoch-a",
        body: "中".repeat(21_845),
      };
      expect(InboxSendInputSchema.safeParse(capture).success).toBe(true);
      expect(
        InboxSendInputSchema.safeParse({ ...capture, body: `${capture.body}中` }).success,
      ).toBe(false);
      expect(
        InboxSendInputSchema.safeParse({ ...capture, operationId: "new-on-every-retry" }).success,
      ).toBe(false);
    });

    it("accepts only trimmed, nonempty, single-line Page titles within the Page title bound", () => {
      const capture = {
        scope: { kind: "library" },
        operationId: createBoundedOperationId("inbox.send"),
        pageId: "page-a",
        documentId: "document-a",
        issuedAt: Date.now(),
        storeEpoch: "epoch-a",
        body: "The message body",
      };
      expect(InboxSendInputSchema.parse(capture)).not.toHaveProperty("title");
      expect(InboxSendInputSchema.parse({ ...capture, title: "  *Literal* [title]  " }).title).toBe(
        "*Literal* [title]",
      );
      expect(
        InboxSendInputSchema.parse({ ...capture, title: "中".repeat(MAX_INBOX_TITLE_LENGTH) })
          .title,
      ).toHaveLength(MAX_INBOX_TITLE_LENGTH);
      for (const title of [
        "",
        " \t ",
        "First\nSecond",
        "First\rSecond",
        "First\tSecond",
        "First\u2028Second",
        "First\u2029Second",
        "a".repeat(MAX_INBOX_TITLE_LENGTH + 1),
        null,
        42,
      ]) {
        expect(InboxSendInputSchema.safeParse({ ...capture, title }).success).toBe(false);
      }
    });

    it("refuses to edit with another Page's revision", () => {
      expect(
        InboxEditInputSchema.safeParse({
          pageId: "page-b",
          basis,
          originalBody: "Before",
          body: "After",
        }).success,
      ).toBe(false);
    });

    it("keeps grouped membership exact and requires a versioned correction for refine", () => {
      const request = {
        requestId: "request-a",
        mode: "grouped",
        pageIds: [basis.pageId],
        basis: [basis],
      };
      expect(InboxSuggestionRequestInputSchema.safeParse(request).success).toBe(true);
      expect(
        InboxSuggestionRequestInputSchema.safeParse({ ...request, pageIds: ["page-b"] }).success,
      ).toBe(false);
      expect(
        InboxSuggestionRequestInputSchema.safeParse({ ...request, mode: "refine" }).success,
      ).toBe(false);
      expect(
        InboxSuggestionRequestInputSchema.safeParse({
          ...request,
          mode: "refine",
          proposalId: "proposal-a",
          expectedRevision: 2,
          correction: "Keep this as a note",
        }).success,
      ).toBe(true);
      expect(
        InboxSuggestionRequestInputSchema.safeParse({ ...request, correction: "Unexpected" })
          .success,
      ).toBe(false);
    });

    it("reads old native preferences once and stores the exact Runtime instance", () => {
      const instanceId = "claude_iJACJTZcFKaFWz0p48xwDri-6ogddDyhfxSQXY-Fn4Y";
      expect(decodeInboxAgentBinding("claude:work-account")).toEqual({ instanceId });
      expect(encodeInboxAgentBinding({ instanceId })).toBe(instanceId);
      expect(decodeInboxAgentBinding("codex")).toEqual({ instanceId: "codex" });
      expect(decodeInboxAgentBinding("claude:")).toBeNull();
    });
    it("validates dispatch policy independently of suggestion admission", () => {
      expect(
        UpdateInboxSettingsInputSchema.parse({
          dispatchMode: "act_on_requests",
          suggestions: "on_request",
        }),
      ).toEqual({ dispatchMode: "act_on_requests", suggestions: "on_request" });
      expect(UpdateInboxSettingsInputSchema.safeParse({ dispatchMode: "automatic" }).success).toBe(
        false,
      );
    });
  });
});

describe("project session Terminal config", () => {
  test("persists only the stable terminal session identity", () => {
    expect(
      parseWorkbenchProjectionTabConfig("terminal", {
        terminalSessionId: "terminal:one",
      }),
    ).toEqual({
      terminalSessionId: "terminal:one",
    });
  });

  test("rejects Project fields that do not belong to Terminal content", () => {
    expect(() =>
      parseWorkbenchProjectionTabConfig("terminal", {
        projectId: "legacy-project",
        terminalSessionId: "terminal:one",
      }),
    ).toThrow();
  });
});

describe("project session Page Stage config", () => {
  test("persists only Page identity, access context, and a title snapshot", () => {
    expect(
      parseWorkbenchProjectionTabConfig("page_stage", {
        routingContext: { kind: "project", projectId: "alpha" },
        pageId: "nested",
        titleSnapshot: "Nested",
      }),
    ).toEqual({
      routingContext: { kind: "project", projectId: "alpha" },
      pageId: "nested",
      titleSnapshot: "Nested",
    });
  });

  test("rejects interaction-derived ancestor trails at the durable boundary", () => {
    expect(() =>
      parseWorkbenchProjectionTabConfig("page_stage", {
        routingContext: { kind: "project", projectId: "alpha" },
        pageId: "nested",
        ancestors: [
          {
            projectId: "stale-project",
            pageId: "root",
            titleSnapshot: "Stale title",
          },
        ],
      }),
    ).toThrow();
  });
});

describe("project session Canvas Stage config", () => {
  test("persists only public Canvas identity, access context, and title fallback", () => {
    expect(
      parseWorkbenchProjectionTabConfig("canvas_stage", {
        routingContext: { kind: "project", projectId: "alpha" },
        canvasBlockId: "canvas:one",
        titleSnapshot: "Sketch",
      }),
    ).toEqual({
      routingContext: { kind: "project", projectId: "alpha" },
      canvasBlockId: "canvas:one",
      titleSnapshot: "Sketch",
    });
  });

  test("rejects missing Canvas identity and private Document identity", () => {
    expect(() =>
      parseWorkbenchProjectionTabConfig("canvas_stage", {
        routingContext: { kind: "project", projectId: "alpha" },
      }),
    ).toThrow();
    expect(() =>
      parseWorkbenchProjectionTabConfig("canvas_stage", {
        routingContext: { kind: "project", projectId: "alpha" },
        canvasBlockId: "canvas:one",
        documentId: "document:private",
      }),
    ).toThrow();
  });
});

describe("project session Files config", () => {
  test("retains a remote host and rejects missing or oversized identities", () => {
    const config = {
      projectId: null,
      hostId: "remote-ssh-discovered:win",
      workspaceRoot: null,
      cwd: "C:/repo",
      path: "C:/repo/file.md",
    };
    expect(parseWorkbenchProjectionTabConfig("files", config)).toEqual(config);
    expect(() => parseWorkbenchProjectionTabConfig("files", { ...config, path: " \t " })).toThrow();
    expect(() => parseWorkbenchProjectionTabConfig("files", { ...config, hostId: " " })).toThrow();
    expect(() =>
      parseWorkbenchProjectionTabConfig("files", { ...config, hostId: "x".repeat(513) }),
    ).toThrow();
  });
  test("persists projectless exact-file tabs without inventing a workspace root", () => {
    expect(
      parseWorkbenchProjectionTabConfig("files", {
        projectId: null,
        hostId: "local",
        workspaceRoot: null,
        cwd: "/tmp/worktree",
        path: "/tmp/worktree/README.md",
      }),
    ).toEqual({
      projectId: null,
      hostId: "local",
      workspaceRoot: null,
      cwd: "/tmp/worktree",
      path: "/tmp/worktree/README.md",
    });
  });

  test("normalizes legacy empty browsing coordinates to no navigation root", () => {
    expect(
      parseWorkbenchProjectionTabConfig("files", {
        projectId: "alpha",
        workspaceRoot: "",
        cwd: "   ",
      }),
    ).toEqual({
      projectId: "alpha",
      hostId: "local",
      workspaceRoot: null,
      cwd: null,
    });
  });
});

describe("project session Review config", () => {
  test("keeps only optional Project workspace metadata", () => {
    expect(
      parseWorkbenchProjectionTabConfig("review", {
        projectId: null,
        context: { kind: "session", sessionId: "session-1" },
      }),
    ).toEqual({
      projectId: null,
    });
  });

  test("normalizes legacy Project-owned Review config to workspace metadata", () => {
    expect(
      parseWorkbenchProjectionTabConfig("review", {
        projectId: "alpha",
        context: { kind: "project", projectId: "alpha" },
      }),
    ).toEqual({
      projectId: "alpha",
    });
  });

  test("rejects Review config without explicit Project metadata", () => {
    expect(() =>
      parseWorkbenchProjectionTabConfig("review", {
        context: { kind: "session", sessionId: "session-1" },
      }),
    ).toThrow();
  });

  test("does not let legacy Review migration erase unknown fields", () => {
    expect(() =>
      parseWorkbenchProjectionTabConfig("review", {
        projectId: "alpha",
        context: { kind: "project", projectId: "alpha" },
        unexpected: true,
      }),
    ).toThrow();
  });
});

describe("Page File configuration", () => {
  const config = {
    routingContext: { kind: "library" },
    pageId: "page",
    fileId: "file",
    logicalPath: "profile/report.html",
    titleSnapshot: "report.html",
  };
  test("round-trips placed and body-only File identities", () => {
    expect(parseWorkbenchProjectionTabConfig("page_file", config)).toEqual(config);
    expect(
      parseWorkbenchProjectionTabConfig("page_file", { ...config, logicalPath: null }).logicalPath,
    ).toBeNull();
  });
  test("rejects runtime capabilities and incomplete resource identity", () => {
    for (const patch of [
      { url: "https://example.com" },
      { grant: "secret" },
      { fileId: "" },
      { logicalPath: "" },
    ])
      expect(() =>
        parseWorkbenchProjectionTabConfig("page_file", { ...config, ...patch }),
      ).toThrow();
  });
});

describe("Project mutation schemas", () => {
  it("rejects the removed legacy icon authority on create and update", () => {
    expect(ProjectCreateInputSchema.safeParse({ icon: "🚀" }).success).toBe(false);
    expect(ProjectUpdateInputSchema.safeParse({ icon: "🚀" }).success).toBe(false);
  });

  it("rejects malformed revision fences instead of treating them as omitted", () => {
    for (const expectedBindingRevision of [0, -1, 1.5, "2", null]) {
      expect(
        ProjectUpdateInputSchema.safeParse({
          expectedBindingRevision,
          name: "Nodex",
        }).success,
      ).toBe(false);
    }
    expect(
      ProjectUpdateInputSchema.safeParse({
        expectedBindingRevision: 2,
        name: "Nodex",
      }).success,
    ).toBe(true);
  });

  it("keeps Database-owned Page-key updates out of Project metadata", () => {
    expect(
      ProjectUpdateInputSchema.safeParse({
        expectedPageKeyNamespaceRevision: 2,
      }).success,
    ).toBe(false);
    expect(
      ProjectUpdateInputSchema.safeParse({
        pageKeyPrefix: "LAB",
        expectedPageKeyNamespaceRevision: 2,
      }).success,
    ).toBe(false);
  });

  it("requires one bounded caller identity around a strict Project update", () => {
    const input = {
      operationId: createBoundedOperationId("workspace.project.update", 1_800_000_000_000),
      projectId: "project:one",
      updates: { name: "Renamed", expectedBindingRevision: 1 },
    };

    expect(ProjectUpdateCommandInputSchema.parse(input)).toEqual(input);
    expect(
      ProjectUpdateCommandInputSchema.safeParse({ ...input, operationId: "operation:legacy" })
        .success,
    ).toBe(false);
    expect(
      ProjectUpdateCommandInputSchema.safeParse({
        ...input,
        updates: { name: "Missing revision" },
      }).success,
    ).toBe(false);
    expect(ProjectUpdateCommandInputSchema.safeParse({ ...input, projectId: " " }).success).toBe(
      false,
    );
    expect(ProjectUpdateCommandInputSchema.safeParse({ ...input, unexpected: true }).success).toBe(
      false,
    );
  });
});

describe("Session ordering inputs", () => {
  test("normalizes optional task search and bounds it by characters", () => {
    expect(ProjectSessionSummaryWindowInputSchema.parse({ query: "  50%_done " }).query).toBe(
      "50%_done",
    );
    expect(ProjectSessionSummaryWindowInputSchema.parse({ query: "  " }).query).toBeUndefined();
    expect(
      ProjectSessionSummaryWindowInputSchema.safeParse({ query: "🌱".repeat(200) }).success,
    ).toBe(true);
    expect(
      ProjectSessionSummaryWindowInputSchema.safeParse({ query: "🌱".repeat(201) }).success,
    ).toBe(false);
  });
});
