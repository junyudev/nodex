import { describe, expect, test, it, vi } from "vite-plus/test";
import {
  buildAutomationHeartbeatPrompt,
  parseAutomationHeartbeatPrompt,
  parseAutomationHeartbeatReply,
  projectAutomationHeartbeatExcerpt,
  projectAutomationHeartbeatReply,
} from "./automation-heartbeat";
import { parseCoreError, parseCoreFailureEvidence } from "./core-failure-evidence";
import {
  NODEX_DEVELOPMENT_FEATURES_ENV,
  developmentFeatureEnvironment,
  isDevelopmentFeatureEnabled,
  parseDevelopmentFeatureEnvironment,
  resolveDevelopmentFeatureOverrides,
} from "./development-features";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { DEFAULT_INBOX_SETTINGS } from "./inbox";
import {
  inboxBudgetPace,
  inboxUsageReading,
  inboxSuggestionPause,
  inboxSuggestionPolicy,
  inboxSuggestionsOffered,
  type InboxSuggestionPolicy,
} from "./inbox-suggestion-policy";
import {
  OPENCODE_INSTALLER_LOG_LINE_LIMIT,
  projectOpenCodeInstallerLog,
} from "./opencode-install-log";
import { projectPromptTurn, UNKNOWN_PROMPT_TURN } from "./prompt-turn";
import {
  buildRemoteHostedPipHiddenHostLayout,
  buildRemoteHostedPipHostLayout,
  serializeRemoteHostedPipHostLayoutIdentity,
} from "./remote-hosted-pip";
import { createSecureRuntimeId, createSecureUuid } from "./secure-runtime-id";
import { SkillSlugSchema, skillInput } from "./skill-inventory";
import { applyTerminalTextDelta } from "./terminal-text";

describe("automation heartbeat", () => {
  const at = "2026-11-10T11:49:09.644Z";
  const prompt = buildAutomationHeartbeatPrompt(
    { id: "automation-1", prompt: "    Review <progress>\n" },
    Date.parse(at),
  );

  describe("heartbeat envelope", () => {
    test("round-trips instructions and keeps the attached Runbook in the visible prompt", () => {
      expect(parseAutomationHeartbeatPrompt(prompt)).toEqual({
        automationId: "automation-1",
        firedAt: at,
        instructions: "    Review <progress>\n",
      });
      const withRunbook = buildAutomationHeartbeatPrompt(
        { id: "automation-1", prompt: "Review progress" },
        Date.parse(at),
        undefined,
        { title: "Checkpoints", pageKey: "OPS-4", body: "- Review the last checkpoint" },
      );
      expect(parseAutomationHeartbeatPrompt(withRunbook)?.instructions).toBe(
        "Review progress\n\nRunbook: Checkpoints (OPS-4)\n- Review the last checkpoint\nYou may update this runbook Page with what future runs should know.",
      );
    });

    test("rejects truncated, embedded and multiple prompts, and decisions it does not recognize", () => {
      expect(parseAutomationHeartbeatPrompt(prompt.slice(0, -1))).toBeNull();
      expect(parseAutomationHeartbeatPrompt(`Explain ${prompt}`)).toBeNull();
      expect(parseAutomationHeartbeatPrompt(`${prompt}\n${prompt}`)).toBeNull();
      expect(
        parseAutomationHeartbeatReply("<heartbeat><decision>MAYBE</decision></heartbeat>"),
      ).toBeNull();
    });

    test("unwraps fenced replies and uses the last decision across multiple envelopes", () => {
      const text = [
        "Checked the queue.",
        "```xml",
        "<heartbeat><decision>NOTIFY</decision><message>Look now</message></heartbeat>",
        "```",
        "It drained.",
        "<heartbeat><decision>DONT_NOTIFY</decision><message>No action needed</message></heartbeat>",
      ].join("\n");
      expect(parseAutomationHeartbeatReply(text)).toEqual({
        decision: "DONT_NOTIFY",
        message: "No action needed",
        body: "Checked the queue.\n\nIt drained.",
      });
    });

    test("never streams a partial XML envelope and reveals an envelope-only notification when settled", () => {
      const envelope =
        "<heartbeat><decision>NOTIFY</decision><message>Review this</message></heartbeat>";
      for (let length = 1; length <= envelope.length; length++) {
        const prefix = envelope.slice(0, length);
        expect(projectAutomationHeartbeatReply(`An update\n\n${prefix}`, true).text).toBe(
          "An update",
        );
        expect(
          projectAutomationHeartbeatReply(`An update\n\n\x60\x60\x60xml\n${prefix}`, true).text,
        ).toBe("An update");
      }
      expect(projectAutomationHeartbeatReply(envelope, true).text).toBe("");
      expect(projectAutomationHeartbeatReply(envelope, false).text).toBe("Review this");
      expect(projectAutomationHeartbeatReply("2 < 3", true).text).toBe("2 < 3");
      const inlineExample = "Use `<heartbeat>` as the opening tag.";
      expect(projectAutomationHeartbeatReply(inlineExample, false).text).toBe(inlineExample);
      expect(
        projectAutomationHeartbeatReply(
          "Checked. <heartbeat><decision>MAYBE</decision></heartbeat>",
          true,
        ),
      ).toEqual({ text: "Checked.", heartbeat: null });
    });

    test("projects clipped search excerpts without making the clock or decision searchable", () => {
      expect(projectAutomationHeartbeatExcerpt("…<instructions>Review progress")).toBe(
        "Review progress",
      );
      expect(projectAutomationHeartbeatExcerpt("…<current_time_iso>2026-11-10…")).toBe("");
      expect(projectAutomationHeartbeatExcerpt("…<decision>DONT_NOTIFY</decision>…")).toBe("");
      expect(projectAutomationHeartbeatExcerpt("…a normal excerpt…")).toBe("…a normal excerpt…");
    });
  });
});

describe("View order preparation evidence", () => {
  it("preserves the exact View to prepare and rejects missing identities", () => {
    expect(
      parseCoreFailureEvidence({
        code: "maintenance_in_progress",
        recovery: { kind: "database_view_order_preparation", view_id: "view:one" },
      }),
    ).toEqual({
      code: "maintenance_in_progress",
      recovery: { kind: "database_view_order_preparation", view_id: "view:one" },
    });
    for (const viewId of [undefined, null, 1, ""]) {
      expect(() =>
        parseCoreFailureEvidence({
          code: "maintenance_in_progress",
          recovery: { kind: "database_view_order_preparation", view_id: viewId },
        }),
      ).toThrow(TypeError);
    }
  });
});

describe("Core error payloads", () => {
  const payload = {
    code: "invalid_input",
    message: "Invalid project identity",
    retryable: false,
    recovery: { kind: "none" },
  } as const;

  it("preserves the generated error contract", () => {
    expect(parseCoreError(payload)).toEqual(payload);
  });

  it("preserves a replay-safe admission refusal with a valid retry delay", () => {
    const refusal = {
      code: "overloaded",
      message: "Core is busy",
      retryable: true,
      recovery: { kind: "retry_admission", milliseconds: 50 },
    } as const;
    expect(parseCoreError(refusal)).toEqual(refusal);
    expect(() =>
      parseCoreError({ ...refusal, recovery: { kind: "retry_admission", milliseconds: -1 } }),
    ).toThrow(TypeError);
  });

  it.each([
    null,
    { ...payload, code: "unknown" },
    { ...payload, message: 1 },
    { ...payload, retryable: "false" },
    { ...payload, recovery: { kind: "unknown" } },
    {
      ...payload,
      recovery: {
        kind: "recovery_package",
        failure: { reason: "invalid_json", effect: "unknown", limit: -1 },
      },
    },
  ])("rejects invalid error evidence: %j", (value) => {
    expect(() => parseCoreError(value)).toThrow(TypeError);
  });
});

describe("Device-link retry evidence", () => {
  const evidence = {
    code: "overloaded",
    recovery: { kind: "retry_after", budget: "member_device_links", milliseconds: 3_599_000 },
  } as const;

  it("preserves the Member budget and retry time across the transport boundary", () => {
    expect(parseCoreFailureEvidence(evidence)).toEqual(evidence);
  });

  it.each([
    { ...evidence.recovery, budget: "unknown" },
    { ...evidence.recovery, milliseconds: -1 },
    { ...evidence.recovery, milliseconds: 1.5 },
  ])("rejects invalid retry evidence: %j", (recovery) => {
    expect(() => parseCoreFailureEvidence({ ...evidence, recovery })).toThrow(TypeError);
  });
});

describe("development feature catalog", () => {
  test("normalizes repeated overrides and rejects unknown features", () => {
    expect(resolveDevelopmentFeatureOverrides(["runtime-metrics", " runtime-metrics "])).toEqual([
      "runtime-metrics",
    ]);
    expect(() => resolveDevelopmentFeatureOverrides(["missing"])).toThrow(
      /Unknown development feature missing\. Available features:/u,
    );
  });

  test("resolves invocation-scoped feature state from one environment key", () => {
    const environment = developmentFeatureEnvironment(["runtime-metrics"]);
    expect(environment).toEqual({
      [NODEX_DEVELOPMENT_FEATURES_ENV]: "runtime-metrics",
    });
    expect(parseDevelopmentFeatureEnvironment(environment)).toEqual(new Set(["runtime-metrics"]));
    expect(isDevelopmentFeatureEnabled("runtime-metrics", environment)).toBe(true);
    expect(isDevelopmentFeatureEnabled("runtime-metrics", {})).toBe(false);
    expect(isDevelopmentFeatureEnabled("agentation", {})).toBe(false);
    expect(isDevelopmentFeatureEnabled("query-devtools", {})).toBe(false);
    expect(isDevelopmentFeatureEnabled("nodex-dynamic-tools", {})).toBe(false);
    expect(
      isDevelopmentFeatureEnabled(
        "nodex-dynamic-tools",
        developmentFeatureEnvironment(["nodex-dynamic-tools"]),
      ),
    ).toBe(true);
  });
});

describe("inbox suggestion policy", () => {
  type Provider = AgentRuntimeOperations["providers.read"]["output"][number];
  type UsageWindow = NonNullable<Provider["usageLimits"]>["windows"][number];
  const NOW = Date.parse("2026-10-26T12:00:00.000Z");
  const hoursFromNow = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
  const window = (overrides: Partial<UsageWindow> = {}): UsageWindow => ({
    id: "weekly",
    kind: "weekly",
    label: "Weekly",
    usedPercent: 70,
    resetsAt: hoursFromNow(130),
    windowDurationMins: 7 * 24 * 60,
    ...overrides,
  });
  const provider: Provider = {
    instanceId: "codex",
    displayName: "Codex",
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: hoursFromNow(0),
    models: [],
    slashCommands: [],
    skills: [],
  };
  const withWindows = (...windows: UsageWindow[]): Provider => ({
    ...provider,
    usageLimits: { checkedAt: hoursFromNow(0), windows },
  });

  // Pace is shared by background admission and the model guidance given to suggestions.
  describe("Inbox budget pace", () => {
    it.each([
      [80, 0.5, "ample"],
      [50, 0.5, "steady"],
      [20, 0.8, "tight"],
      [1, 0.1, "spent"],
      [2, null, "spent"],
      [2.01, null, "steady"],
      [50, null, "ample"],
      [49, 0, "steady"],
      [40, 0.5, "steady"],
      [39.99, 0.5, "tight"],
      [62.5, 0.5, "ample"],
      [62.49, 0.5, "steady"],
    ] as const)("reads %s%% left with time fraction %s as %s", (left, time, expected) => {
      expect(inboxBudgetPace(left, time)).toBe(expected);
    });

    it("reads bounded remaining usage and time from a provider window", () => {
      expect(inboxUsageReading(window(), NOW)).toMatchObject({
        leftPercent: 30,
        resetsInHours: 130,
        pace: "tight",
      });
      expect(inboxUsageReading(window({ usedPercent: 105 }), NOW).leftPercent).toBe(0);
      expect(inboxUsageReading(window({ usedPercent: -5 }), NOW).leftPercent).toBe(100);
      expect(inboxUsageReading(window({ resetsAt: undefined }), NOW)).toMatchObject({
        resetsInHours: null,
        pace: "steady",
      });
    });
  });

  describe("Inbox suggestion policy", () => {
    it("allows automatic advice when no usage data is known", () => {
      expect(inboxSuggestionPolicy(DEFAULT_INBOX_SETTINGS, [provider], NOW)).toEqual({
        kind: "automatic",
      });
      expect(inboxSuggestionPause(withWindows(), NOW)).toBeNull();
    });

    it("keeps automatic advice while a fast window still has more than 10% left", () => {
      // 30% left with most of the week to go is spending fast, but far from running out.
      expect(inboxUsageReading(window(), NOW).pace).toBe("tight");
      expect(inboxSuggestionPolicy(DEFAULT_INBOX_SETTINGS, [withWindows(window())], NOW)).toEqual({
        kind: "automatic",
      });
      expect(inboxSuggestionPause(withWindows(window({ usedPercent: 90 })), NOW)).toBeNull();
    });

    it("pauses automatic advice once a fast window is under 10% left", () => {
      expect(
        inboxSuggestionPolicy(
          DEFAULT_INBOX_SETTINGS,
          [withWindows(window({ usedPercent: 92 }))],
          NOW,
        ),
      ).toEqual({
        kind: "paused",
        pause: {
          pace: "tight",
          agent: "Codex",
          window: "Weekly",
          leftPercent: 8,
          resetsAt: hoursFromNow(130),
        },
      });
    });

    it("pauses on a spent window whatever its pace", () => {
      expect(
        inboxSuggestionPause(
          withWindows(window({ usedPercent: 99, resetsAt: hoursFromNow(1) })),
          NOW,
        ),
      ).toMatchObject({ pace: "spent", leftPercent: 1 });
    });

    it("gives a spent window priority over a tight window", () => {
      expect(
        inboxSuggestionPause(
          withWindows(window({ usedPercent: 95 }), window({ label: "Session", usedPercent: 98 })),
          NOW,
        ),
      ).toMatchObject({ pace: "spent", window: "Session", leftPercent: 2 });
    });

    it("uses the lowest remaining share among constrained windows regardless of order", () => {
      const weekly = window({ usedPercent: 93 });
      const session = window({ label: "Session", usedPercent: 95 });
      for (const windows of [
        [weekly, session],
        [session, weekly],
      ])
        expect(inboxSuggestionPause(withWindows(...windows), NOW)).toMatchObject({
          window: "Session",
          leftPercent: 5,
        });
    });

    it("ignores windows at or past their reset time", () => {
      expect(
        inboxSuggestionPolicy(
          DEFAULT_INBOX_SETTINGS,
          [
            withWindows(
              window({ resetsAt: hoursFromNow(-1), usedPercent: 100 }),
              window({ resetsAt: hoursFromNow(0), usedPercent: 100 }),
            ),
          ],
          NOW,
        ),
      ).toEqual({ kind: "automatic" });
    });

    it("uses only the suggestion Agent's usage and allows an Agent missing from the catalog", () => {
      const other = { ...withWindows(window()), instanceId: "another-agent" };
      expect(inboxSuggestionPolicy(DEFAULT_INBOX_SETTINGS, [other], NOW)).toEqual({
        kind: "automatic",
      });
      expect(inboxSuggestionPolicy(DEFAULT_INBOX_SETTINGS, [], NOW)).toEqual({ kind: "automatic" });
    });

    it.each(["on_request", "off"] as const)("keeps %s regardless of usage", (suggestions) => {
      expect(
        inboxSuggestionPolicy(
          { ...DEFAULT_INBOX_SETTINGS, suggestions },
          [withWindows(window())],
          NOW,
        ),
      ).toEqual({ kind: suggestions });
    });

    it("offers explicit advice in every policy except off", () => {
      const paused = inboxSuggestionPolicy(DEFAULT_INBOX_SETTINGS, [withWindows(window())], NOW);
      for (const policy of [
        paused,
        { kind: "automatic" },
        { kind: "on_request" },
      ] satisfies InboxSuggestionPolicy[])
        expect(inboxSuggestionsOffered(policy)).toBe(true);
      expect(inboxSuggestionsOffered({ kind: "off" })).toBe(false);
    });
  });
});

describe("opencode install log", () => {
  const ESC = "\u001b";

  describe("installer output", () => {
    test("shows text without color, cursor or title escapes", () => {
      expect(
        projectOpenCodeInstallerLog(
          `${ESC}]0;install${ESC}\\${ESC}[0;2mInstalling ${ESC}[0mopencode ${ESC}[0;2mversion: ${ESC}[0m2.0.18\n` +
            `${ESC}[?25l${ESC}[0;31mFailed to fetch version information${ESC}[0m\n`,
        ),
      ).toEqual({
        lines: ["Installing opencode version: 2.0.18", "Failed to fetch version information"],
        progress: null,
      });
    });

    test("overwrites in place after carriage returns, but treats CRLF as a line break", () => {
      expect(projectOpenCodeInstallerLog("abcdef\rXY\nfirst\r\nsecond\r")).toEqual({
        lines: ["XYcdef", "first", "second"],
        progress: null,
      });
    });

    test("reports the latest share from a redrawn meter and keeps the meter out of the log", () => {
      expect(
        projectOpenCodeInstallerLog(
          "Installing opencode version: 2.0.18\n" +
            "\r###                                   7.5%" +
            "\r##############                       42.5%",
        ),
      ).toEqual({ lines: ["Installing opencode version: 2.0.18"], progress: 0.425 });
    });

    test("keeps a completed download at full progress while later steps print", () => {
      expect(
        projectOpenCodeInstallerLog(
          `\r${"#".repeat(60)} 100.0%\n` +
            "Successfully added opencode to $PATH in /Users/me/.zshrc\n",
        ),
      ).toEqual({
        lines: ["Successfully added opencode to $PATH in /Users/me/.zshrc"],
        progress: 1,
      });
    });

    test("recognizes the installer's own terminal meter", () => {
      expect(
        projectOpenCodeInstallerLog(`\r${ESC}[38;5;214m■■■■■･････････  36%${ESC}[0m`).progress,
      ).toBe(0.36);
    });

    test("stays indeterminate when a transfer never reports its size", () => {
      expect(projectOpenCodeInstallerLog("Downloading\n\r#=#=#\r-=O=-   #   #\n")).toEqual({
        lines: ["Downloading"],
        progress: null,
      });
    });

    test("drops block-art lettering but keeps indentation and single blank lines", () => {
      expect(
        projectOpenCodeInstallerLog(
          "\n\n                    ▄\n█▀▀█ █░░█ ▀▀▀▀   \n\n\n\ncd <project>  # Open directory\n\n\n" +
            "  export PATH=/Users/me/.opencode/bin:$PATH\n\n",
        ).lines,
      ).toEqual([
        "cd <project>  # Open directory",
        "",
        "  export PATH=/Users/me/.opencode/bin:$PATH",
      ]);
    });

    test("bounds scrollback and line length", () => {
      const raw = Array.from({ length: OPENCODE_INSTALLER_LOG_LINE_LIMIT + 50 }, (_, index) =>
        index === OPENCODE_INSTALLER_LOG_LINE_LIMIT + 49 ? "x".repeat(1_000) : `line ${index}`,
      ).join("\n");
      const { lines } = projectOpenCodeInstallerLog(raw);
      expect(lines).toHaveLength(OPENCODE_INSTALLER_LOG_LINE_LIMIT);
      expect(lines[0]).toBe("line 50");
      expect(lines.at(-1)).toHaveLength(400);
      expect(lines.at(-1)?.endsWith("…")).toBe(true);
    });

    test("an empty tail has no lines and no progress", () => {
      expect(projectOpenCodeInstallerLog("")).toEqual({ lines: [], progress: null });
    });
  });
});

describe("prompt turn", () => {
  type Outcome = NonNullable<AgentRuntimeOperations["thread.message-turn"]["output"]>;
  describe("Prompt Turn projection", () => {
    it.each([
      ["queued", "queued"],
      ["preparing", "working"],
      ["starting", "working"],
      ["running", "working"],
      ["waiting", "waiting"],
      ["completed", "done"],
      ["failed", "failed"],
      ["interrupted", "interrupted"],
      ["cancelled", "interrupted"],
      ["rolled_back", "unknown"],
    ] as const)("maps %s to %s without borrowing another Turn's activity", (status, phase) => {
      const outcome: Outcome = {
        runId: "original",
        startedAt: null,
        status,
        completedAt: null,
        finalAssistantItemId: "answer",
      };
      const turn = projectPromptTurn(outcome, "**Final** answer");
      expect(turn).toEqual({
        phase,
        runId: "original",
        reply: phase === "done" ? "**Final** answer" : null,
      });
    });
    it("returns unknown for a missing, legacy, or unavailable message", () => {
      expect(projectPromptTurn(null)).toBe(UNKNOWN_PROMPT_TURN);
    });
  });
});

describe("remote-hosted PiP layout", () => {
  test("builds the four reference anchors for an unobstructed thread host", () => {
    const layout = buildRemoteHostedPipHostLayout({
      hostRect: {
        height: 800,
        width: 1_000,
        x: 100,
        y: 50,
      },
      obstacleRects: [],
    });

    expect(layout.hostId).toBe("codex-main-thread");
    expect(layout.presentationScope).toBe("thread");
    expect(JSON.stringify(layout.anchors)).toBe(
      JSON.stringify([
        { alignment: "top-left", point: { x: 124, y: 74 } },
        { alignment: "top-right", point: { x: 1_076, y: 74 } },
        { alignment: "bottom-left", point: { x: 124, y: 826 } },
        { alignment: "bottom-right", point: { x: 1_076, y: 826 } },
      ]),
    );
  });

  test("moves bottom anchors away from footer obstacles", () => {
    const layout = buildRemoteHostedPipHostLayout({
      hostRect: {
        height: 800,
        width: 1_000,
        x: 100,
        y: 50,
      },
      obstacleRects: [
        {
          height: 120,
          width: 1_000,
          x: 100,
          y: 730,
        },
      ],
    });

    const anchors = layout.anchors ?? [];
    const bottomLeft = anchors.find((anchor) => anchor.alignment === "bottom-left");
    const bottomRight = anchors.find((anchor) => anchor.alignment === "bottom-right");

    expect(bottomLeft?.point.y ?? 0).toBe(718);
    expect(bottomRight?.point.y ?? 0).toBe(718);
  });

  test("places the top-right presentation below the available Home surface", () => {
    const layout = buildRemoteHostedPipHostLayout({
      homeSurfaceRect: {
        height: 300,
        width: 320,
        x: 740,
        y: 80,
      },
      hostRect: {
        height: 800,
        width: 1_000,
        x: 100,
        y: 50,
      },
      isCodexHomeAvailable: true,
      obstacleRects: [],
    });

    const topRight = layout.anchors?.find((anchor) => anchor.alignment === "top-right");
    expect(topRight?.point).toEqual({ x: 1_060, y: 392 });
    expect(layout.isCodexHomeAvailable).toBe(true);
  });

  test("hidden layout clears the native host without anchors", () => {
    const layout = buildRemoteHostedPipHiddenHostLayout();

    expect(layout.hostId).toBe("codex-main-thread");
    expect(layout.anchorRect === null).toBe(true);
    expect(layout.anchors === null).toBe(true);
  });

  test("layout identity ignores animation-only changes", () => {
    const layout = buildRemoteHostedPipHostLayout({
      hostRect: {
        height: 800,
        width: 1_000,
        x: 100,
        y: 50,
      },
      obstacleRects: [],
    });
    const animatedLayout = {
      ...layout,
      animated: true,
    };

    expect(serializeRemoteHostedPipHostLayoutIdentity(layout)).toBe(
      serializeRemoteHostedPipHostLayoutIdentity(animatedLayout),
    );
  });
});

describe("secure runtime identities", () => {
  test("uses the injected secure UUID source without a weak fallback", () => {
    const createUuid = () => "019c8bd7-62eb-7000-8000-000000000001";

    expect(createSecureUuid(createUuid)).toBe("019c8bd7-62eb-7000-8000-000000000001");
    expect(createSecureRuntimeId("surface", createUuid)).toBe(
      "surface:019c8bd7-62eb-7000-8000-000000000001",
    );
  });

  test("fails closed when the default Web Crypto source is unavailable", () => {
    vi.stubGlobal("crypto", undefined);
    try {
      expect(() => createSecureUuid()).toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("skill inventory", () => {
  it("accepts portable skill slugs and rejects reserved or multi-segment names", () => {
    expect(SkillSlugSchema.safeParse("my-skill-2").success).toBe(true);
    for (const slug of [
      "",
      ".",
      "..",
      ".system",
      "con",
      "com1",
      "lpt9",
      "trail.",
      "trail ",
      "/a",
      "a/b",
      "a\\b",
      "a\0b",
      "A",
      "a".repeat(65),
    ]) {
      expect(SkillSlugSchema.safeParse(slug).success, slug).toBe(false);
    }
    expect(skillInput.list.safeParse({ hostId: "local", projectId: null }).success).toBe(true);
  });
});

describe("terminal text", () => {
  const MAX_CHARS = 32_000;

  describe("applyTerminalTextDelta", () => {
    test("preserves split CRLF and overwrites a line after a bare carriage return", () => {
      const pending = applyTerminalTextDelta({
        currentText: "first",
        delta: "\r",
        maxChars: MAX_CHARS,
      });
      expect(pending).toEqual({
        text: "first",
        carriageReturnPending: true,
        didTruncate: false,
      });

      const crlf = applyTerminalTextDelta({
        currentText: pending.text,
        delta: "\nsecond\rreplacement",
        carriageReturnPending: pending.carriageReturnPending,
        didTruncate: pending.didTruncate,
        maxChars: MAX_CHARS,
      });
      expect(crlf.text).toBe("first\nreplacement");
      expect(crlf.carriageReturnPending).toBe(false);
    });

    test("applies backspaces across delta boundaries", () => {
      const first = applyTerminalTextDelta({
        currentText: "",
        delta: "abc\b",
        maxChars: MAX_CHARS,
      });
      const second = applyTerminalTextDelta({
        currentText: first.text,
        delta: "\bZ",
        maxChars: MAX_CHARS,
        didTruncate: first.didTruncate,
      });

      expect(second.text).toBe("aZ");
    });

    test("retains only the newest characters from one oversized delta", () => {
      const result = applyTerminalTextDelta({
        currentText: "old",
        delta: "x".repeat(MAX_CHARS + 7),
        maxChars: MAX_CHARS,
      });

      expect(result.text).toBe("x".repeat(MAX_CHARS));
      expect(result.didTruncate).toBe(true);
    });
  });
});
