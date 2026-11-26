import { describe, expect, test, it, vi, beforeAll } from "vite-plus/test";
import { chatHighlightSegments, chatFieldHighlightSegments } from "./chat-search";
import { resolveChatSessionForThreadId } from "./chat-session-for-thread";
import {
  chatSnoozePresetTime,
  chatSnoozePresets,
  describeChatSnooze,
  describeChatSnoozeAbsolute,
  formatChatSnoozeConfirmation,
  formatChatSnoozeTime,
  formatSnoozeWakeLabel,
  presentSnoozedLane,
  resolveSnoozeHorizon,
} from "./chat-snooze";
import {
  earliestSnoozeInstant,
  initialSnoozeDraft,
  parseSnoozePhrase,
  snoozeDraftInstant,
  snoozeDraftIsPast,
  snoozeDraftOnDay,
  snoozeTimeSlots,
} from "./custom-snooze-time";
import type { CodexThreadSummary, ProjectSession } from "../../shared/types";
import { nativeConversationIdentity } from "./conversation-identity";
import { prepareCreatedThreadNavigation } from "./created-thread-navigation";
import type { CodexCreatedThreadResolution } from "../../shared/codex-child-thread-summary";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import { QueryClient } from "@tanstack/react-query";
import { projectAgentRuntimeItem } from "../features/local-conversation/agent-runtime-transcript-projection";
import { conversationImageScope } from "../features/local-conversation/view/conversation-markdown-source";
import { parseAgentRuntimeAttachmentSource } from "../../shared/agent-runtime-attachments";
import { readContentImage } from "./content-image/content-image-read";
import { resolveConversationMediaTarget } from "./content-image/media-target";
import { bindRendererSpace } from "./renderer-space";
import { separateHostedChatUploads } from "./hosted-chat";
import type { Project } from "./types";
import {
  buildNewChatProjectSelectorOptions,
  filterNewChatProjectSelectorOptions,
  resolveSelectedNewChatProjectSelectorOption,
} from "./new-chat-project-selector";

describe("chat search presentation", () => {
  test("cuts CJK text at its matched ranges without splitting characters", () => {
    expect(chatHighlightSegments("帮我把我的服务器配置一下", [{ start: 5, end: 8 }])).toEqual([
      { text: "帮我把我的", highlight: false },
      { text: "服务器", highlight: true },
      { text: "配置一下", highlight: false },
    ]);
    expect(chatHighlightSegments("No match", [])).toBeNull();
  });

  test("offsets a branch hint past the worktree prefix it omits", () => {
    const hint = { label: "Branch", text: "fix-search", ranges: [{ start: 4, end: 10 }] };
    expect(chatFieldHighlightSegments("nodex/runtime/fix-search", hint, "Branch")).toEqual([
      { text: "nodex/runtime/fix-", highlight: false },
      { text: "search", highlight: true },
    ]);
    expect(chatFieldHighlightSegments("Nodex", hint, "Project")).toBeNull();
  });
});

describe("chat session for thread", () => {
  interface Session {
    readonly id: string;
    readonly archived: boolean;
    readonly executionRef?: { readonly threadId: string } | null;
    readonly thread?: { readonly threadId: string } | null;
  }

  const runtimeThreadId =
    "nodex:thread:6d6c200f396dbc87ece0a38200ab03e7d6e7cadbb14568f0c02f8996ae2bec9c";

  function ports(
    overrides: Partial<Parameters<typeof resolveChatSessionForThreadId<Session>>[1]> = {},
  ) {
    const calls: string[] = [];
    return {
      calls,
      value: {
        knownSessions: [] as Session[],
        readAgentThreadSessionId: async (id: string) => {
          calls.push(`read:${id}`);
          return "session-runtime";
        },
        resolveSessionById: async (id: string): Promise<Session> => {
          calls.push(`session:${id}`);
          return { id, archived: false, executionRef: { threadId: runtimeThreadId } };
        },
        ensureThreadSession: async (id: string): Promise<Session | null> => {
          calls.push(`ensure:${id}`);
          return { id: "session-native", archived: false, thread: { threadId: id } };
        },
        ...overrides,
      },
    };
  }

  describe("resolveChatSessionForThreadId", () => {
    test("prefers a known live Session for either execution identity", async () => {
      const known: Session = { id: "known", archived: false, executionRef: { threadId: "t-1" } };
      const { calls, value } = ports({ knownSessions: [known] });

      expect(await resolveChatSessionForThreadId("t-1", value)).toBe(known);
      expect(calls).toEqual([]);
    });

    test("finds an Agent Runtime Thread's own Session instead of admitting it as native", async () => {
      const { calls, value } = ports();

      const session = await resolveChatSessionForThreadId(runtimeThreadId, value);

      expect(session.id).toBe("session-runtime");
      expect(calls).toEqual([`read:${runtimeThreadId}`, "session:session-runtime"]);
    });

    test("admits a native Thread and refuses one that is gone", async () => {
      const admitted = ports();
      expect((await resolveChatSessionForThreadId("native-1", admitted.value)).id).toBe(
        "session-native",
      );
      expect(admitted.calls).toEqual(["ensure:native-1"]);

      const gone = ports({ ensureThreadSession: async () => null });
      await expect(resolveChatSessionForThreadId("native-2", gone.value)).rejects.toThrow(
        "This chat is no longer available",
      );
    });
  });
});

describe("chat snooze", () => {
  const local = (y: number, m: number, d: number, h: number, min = 0, s = 0) =>
    new Date(y, m - 1, d, h, min, s);
  const presetTimes = (now: Date) =>
    Object.fromEntries(
      chatSnoozePresets(now, "en-US").map((p) => [p.id, new Date(p.snoozedUntil)]),
    );

  describe("chatSnoozePresets", () => {
    it("offers an hour, three hours, tomorrow morning and next Monday on an ordinary afternoon", () => {
      // Wednesday, Nov 4 2026, 2:15:30 PM
      const now = local(2026, 11, 4, 14, 15, 30);
      const presets = chatSnoozePresets(now, "en-US");
      expect(presets.map((p) => p.label)).toEqual([
        "In 1 hour",
        "In 3 hours",
        "Tomorrow, 9:00 AM",
        "Next week, Mon 9:00 AM",
      ]);
      // A menu with a time column shows each name beside when it brings the chat back.
      expect(presets.map((p) => [p.name, p.when])).toEqual([
        ["In 1 hour", "3:16 PM"],
        ["In 3 hours", "5:16 PM"],
        ["Tomorrow", "9:00 AM"],
        ["Next week", "Mon 9:00 AM"],
      ]);
      const times = presetTimes(now);
      // Relative presets land on a whole minute, never earlier than asked.
      expect(times["in-1-hour"]).toEqual(local(2026, 11, 4, 15, 16));
      expect(times["in-3-hours"]).toEqual(local(2026, 11, 4, 17, 16));
      expect(times["next-morning"]).toEqual(local(2026, 11, 5, 9));
      expect(times["next-week"]).toEqual(local(2026, 11, 9, 9));
    });

    it("keeps an exact whole minute instead of rounding it up", () => {
      expect(presetTimes(local(2026, 11, 4, 14, 15))["in-1-hour"]).toEqual(
        local(2026, 11, 4, 15, 15),
      );
    });

    it("means this morning in the small hours, but tomorrow once 9 AM is under three hours away", () => {
      const smallHours = chatSnoozePresets(local(2026, 11, 4, 1, 30), "en-US");
      expect(smallHours.find((p) => p.id === "next-morning")?.label).toBe("This morning, 9:00 AM");
      expect(new Date(smallHours.find((p) => p.id === "next-morning")!.snoozedUntil)).toEqual(
        local(2026, 11, 4, 9),
      );

      const early = presetTimes(local(2026, 11, 4, 6, 30));
      expect(early["next-morning"]).toEqual(local(2026, 11, 5, 9));
    });

    it("moves a Monday's next week a full week ahead", () => {
      expect(presetTimes(local(2026, 11, 9, 10))["next-week"]).toEqual(local(2026, 11, 16, 9));
    });

    it("drops next week from the menu when it lands on the same time as tomorrow morning", () => {
      // Sunday evening: tomorrow 9 AM is next week's Monday 9 AM.
      const sunday = local(2026, 11, 8, 20);
      const presets = chatSnoozePresets(sunday, "en-US");
      expect(presets.map((p) => p.id)).toEqual(["in-1-hour", "in-3-hours", "next-morning"]);
      // A surface that names next week by itself still gets that Monday.
      expect(new Date(chatSnoozePresetTime("next-week", sunday))).toEqual(local(2026, 11, 9, 9));
    });
  });

  describe("describeChatSnooze", () => {
    const now = local(2026, 11, 4, 14, 0);

    it("names the day relative to now", () => {
      expect(describeChatSnooze(local(2026, 11, 4, 17, 30).toISOString(), now, "en-US")).toBe(
        "Snoozed until today at 5:30 PM",
      );
      expect(describeChatSnooze(local(2026, 11, 5, 9).toISOString(), now, "en-US")).toBe(
        "Snoozed until tomorrow at 9:00 AM",
      );
      expect(describeChatSnooze(local(2026, 11, 9, 9).toISOString(), now, "en-US")).toBe(
        "Snoozed until Mon, Nov 9 at 9:00 AM",
      );
      expect(formatChatSnoozeTime(local(2027, 1, 4, 9).toISOString(), now, "en-US")).toBe(
        "Mon, Jan 4, 2027 at 9:00 AM",
      );
    });

    it("confirms and describes a snooze without depending on when it is read", () => {
      expect(formatChatSnoozeConfirmation(local(2026, 11, 5, 9).toISOString(), now, "en-US")).toBe(
        "Snoozed until tomorrow at 9:00 AM",
      );
      expect(describeChatSnoozeAbsolute(local(2026, 11, 5, 9).toISOString(), "en-US")).toBe(
        "Snoozed until Thu, Nov 5, 9:00 AM",
      );
    });

    it("calls a snooze at or past now due", () => {
      expect(describeChatSnooze(now.toISOString(), now, "en-US")).toBe("Snooze ended");
      expect(describeChatSnooze("not a time", now, "en-US")).toBe("Snooze ended");
    });
  });

  describe("the Snoozed lane", () => {
    // Friday, Nov 6 2026, 6:00 PM
    const now = local(2026, 11, 6, 18);
    const at = (...parts: Parameters<typeof local>) => local(...parts).toISOString();

    it("names a return by the nearest thing that tells it apart", () => {
      expect(formatSnoozeWakeLabel(at(2026, 11, 6, 19), now, "en-US")).toBe("7:00 PM");
      // A late three-hour snooze crosses midnight and still reads as a time.
      const late = local(2026, 11, 6, 22);
      expect(formatSnoozeWakeLabel(at(2026, 11, 7, 1), late, "en-US")).toBe("1:00 AM");
      expect(formatSnoozeWakeLabel(at(2026, 11, 7, 9), now, "en-US")).toBe("Tomorrow");
      expect(formatSnoozeWakeLabel(at(2026, 11, 9, 9), now, "en-US")).toBe("Mon");
      expect(formatSnoozeWakeLabel(at(2026, 11, 13, 9), now, "en-US")).toBe("Nov 13");
      expect(formatSnoozeWakeLabel(at(2027, 1, 4, 9), now, "en-US")).toBe("Jan 4, 2027");
    });

    it("keeps tomorrow near and steps back from everything after it", () => {
      expect(resolveSnoozeHorizon(at(2026, 11, 7, 23, 59), now)).toBe("soon");
      expect(resolveSnoozeHorizon(at(2026, 11, 8, 0), now)).toBe("later");
      // On Sunday, next week's Monday is tomorrow, so it stays near.
      expect(resolveSnoozeHorizon(at(2026, 11, 9, 9), local(2026, 11, 8, 20))).toBe("soon");
    });

    it("folds the chats returning later and names when they return", () => {
      const lane = presentSnoozedLane(
        [
          { id: "hour", snoozedUntil: at(2026, 11, 6, 19) },
          { id: "morning", snoozedUntil: at(2026, 11, 7, 9) },
          { id: "monday", snoozedUntil: at(2026, 11, 9, 9) },
          { id: "month", snoozedUntil: at(2026, 12, 8, 9) },
        ],
        now,
        "en-US",
      );
      expect(lane.fold).toEqual({ from: 2, count: 2, range: "Mon – Dec 8" });
      expect([...lane.later]).toEqual(["monday", "month"]);
      expect([...lane.wakeLabels.values()]).toEqual(["7:00 PM", "Tomorrow", "Mon", "Dec 8"]);
      // Nothing comes within hours before midnight, so the turning day is the next change.
      expect(lane.nextChangeAt).toBe(local(2026, 11, 7, 0).getTime());
    });

    it("never folds a sooner chat that a held lane lists below a later one", () => {
      const lane = presentSnoozedLane(
        [
          { id: "december", snoozedUntil: at(2026, 12, 5, 9) },
          { id: "tomorrow", snoozedUntil: at(2026, 11, 7, 9) },
          { id: "monday", snoozedUntil: at(2026, 11, 9, 9) },
        ],
        now,
        "en-US",
      );
      expect(lane.fold).toEqual({ from: 2, count: 1, range: "Mon" });
      expect([...lane.later]).toEqual(["december", "monday"]);
    });

    it("leaves the chat on screen out of what the fold counts and names", () => {
      const chats = [
        { id: "monday", snoozedUntil: at(2026, 11, 9, 9) },
        { id: "eighth", snoozedUntil: at(2026, 12, 8, 9) },
        { id: "ninth", snoozedUntil: at(2026, 12, 9, 9) },
      ];
      expect(presentSnoozedLane(chats, now, "en-US", "monday").fold).toEqual({
        from: 0,
        count: 2,
        range: "Dec 8 – Dec 9",
      });
      expect(presentSnoozedLane(chats, now, "en-US", "ninth").fold?.range).toBe("Mon – Dec 8");
    });

    it("reads again when a return comes within hours, before the day turns", () => {
      const lane = presentSnoozedLane(
        [{ id: "late", snoozedUntil: at(2026, 11, 7, 1) }],
        now,
        "en-US",
      );
      expect(lane.wakeLabels.get("late")).toBe("Tomorrow");
      expect(lane.nextChangeAt).toBe(local(2026, 11, 6, 19).getTime());
      expect(lane.fold).toBeNull();
    });
  });

  describe("custom snooze time", () => {
    // Thursday, Nov 26 2026, 2:15:30 PM
    const now = local(2026, 11, 26, 14, 15, 30);
    const today = local(2026, 11, 26, 0);
    const tomorrow = local(2026, 11, 27, 0);
    const fallbackMinutes = 10 * 60 + 45;

    it("starts at the next morning", () => {
      expect(initialSnoozeDraft(now)).toEqual({ day: tomorrow, minutes: 9 * 60 });
    });

    it("moves earlier selections to the first available slot of the earliest day", () => {
      const expected = { day: today, minutes: 14 * 60 + 30 };
      expect(snoozeDraftOnDay(today, 9 * 60, now)).toEqual(expected);
      expect(snoozeDraftOnDay(local(2026, 11, 25, 0), 9 * 60, now)).toEqual(expected);
    });

    it("uses the earliest allowed minute when the day has no half-hour slots left", () => {
      const late = local(2026, 11, 26, 23, 45, 30);
      const draft = snoozeDraftOnDay(today, 9 * 60, late);
      expect(draft).toEqual({ day: today, minutes: 23 * 60 + 47 });
      expect(earliestSnoozeInstant(late)).toEqual(local(2026, 11, 26, 23, 47));
      expect(snoozeDraftInstant(draft)).toEqual(earliestSnoozeInstant(late));
    });

    it("inserts the selected minute in order and disables times before the earliest instant", () => {
      const slots = snoozeTimeSlots({ day: today, minutes: 14 * 60 + 17 }, now, "en-US");
      expect(slots).toHaveLength(49);
      expect(slots.slice(28, 31)).toEqual([
        { minutes: 14 * 60, label: "2:00 PM", disabled: true },
        { minutes: 14 * 60 + 17, label: "2:17 PM", disabled: false },
        { minutes: 14 * 60 + 30, label: "2:30 PM", disabled: false },
      ]);
    });

    it.each([
      ["  fri 3pm.  ", "en-US", tomorrow, 15 * 60],
      ["at 5", "en-US", today, 17 * 60],
      ["at 1", "en-US", tomorrow, 13 * 60],
      ["tomorrow at 5", "en-US", tomorrow, 17 * 60],
      ["fri at 3", "en-US", tomorrow, 15 * 60],
      ["fri 3pm to 5pm", "en-US", tomorrow, 15 * 60],
      ["tomorrow morning", "en-US", tomorrow, 9 * 60],
      ["this evening", "en-US", today, 20 * 60],
      ["tomorrow", "en-US", tomorrow, fallbackMinutes],
      ["fri", "en-US", tomorrow, fallbackMinutes],
      ["today", "en-US", today, 14 * 60 + 30],
      ["in 2 hours", "en-US", today, 16 * 60 + 15],
      ["明天下午3点", "zh-CN", tomorrow, 15 * 60],
      ["下周一", "zh-CN", local(2026, 11, 30, 0), fallbackMinutes],
      ["tomorrow", "zh-CN", tomorrow, fallbackMinutes],
    ] as const)("reads %j in %s", (phrase, locale, day, minutes) => {
      expect(parseSnoozePhrase(phrase, now, locale, fallbackMinutes)).toEqual({
        kind: "time",
        draft: { day, minutes },
      });
    });

    it.each([
      ["tom 3pm", "unreadable"],
      ["something else", "unreadable"],
      ["   ", "empty"],
    ] as const)("classifies %j as %s", (phrase, kind) => {
      expect(parseSnoozePhrase(phrase, now, "en-US", fallbackMinutes)).toEqual({ kind });
    });

    it("reads a phrase counted from now as it is, even in the small hours", () => {
      const midnight = local(2026, 11, 26, 0, 0, 0);
      expect(parseSnoozePhrase("两小时后", midnight, "zh-CN", fallbackMinutes)).toEqual({
        kind: "time",
        draft: { day: today, minutes: 2 * 60 },
      });
    });

    it("preserves an explicit past time for the picker to flag", () => {
      const result = parseSnoozePhrase("today 9am", now, "en-US", fallbackMinutes);
      expect(result).toEqual({ kind: "time", draft: { day: today, minutes: 9 * 60 } });
      expect(result.kind === "time" && snoozeDraftIsPast(result.draft, now)).toBe(true);
    });
  });
});

describe("conversation identity", () => {
  const summary = (overrides: Partial<CodexThreadSummary> = {}): CodexThreadSummary => ({
    threadId: "019a0000-0000-7000-8000-000000000001",
    projectId: "project",
    sessionId: "session",
    threadName: "Release notes",
    threadPreview: "Draft the notes",
    cwd: null,
    source: null,
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    linkedAt: "2026-11-01T00:00:00.000Z",
    executionProfile: { modelId: "gpt-6.1-sol", reasoningEffort: "high", serviceTier: null },
    ...overrides,
  });

  describe("native conversation identity", () => {
    test("names a local Codex chat with the model it runs", () => {
      expect(nativeConversationIdentity(summary(), null)).toEqual({
        threadId: "019a0000-0000-7000-8000-000000000001",
        sessionId: "session",
        title: "Release notes",
        role: "chat",
        agent: { kind: "codex", providerInstanceId: null, model: "gpt-6.1-sol", effort: "high" },
        archived: false,
        host: null,
      });
    });

    test("carries the execution host's name for a conversation on another machine", () => {
      const remote = nativeConversationIdentity(summary({ executionHostId: "build-box" }), {
        sshHosts: [
          {
            id: "build-box",
            displayName: "Build box",
            kind: "ssh",
            sshAlias: "build",
            port: null,
            managedRoot: "/srv",
            repositoryRoots: [],
            codexBinary: null,
            codexHome: null,
            enabled: true,
          },
        ],
      });
      expect(remote.host).toEqual({ id: "build-box", name: "Build box" });
      expect(nativeConversationIdentity(summary({ executionHostId: "gone" }), null).host).toEqual({
        id: "gone",
        name: "gone",
      });
    });

    test("names a native subagent by its nickname and an untitled chat by its preview", () => {
      const child = nativeConversationIdentity(
        summary({ threadName: null, agentNickname: "Explorer", agentPath: "/root/explorer" }),
        null,
      );
      expect(child).toMatchObject({ title: "Explorer", role: "subagent" });
      expect(nativeConversationIdentity(summary({ threadName: "  " }), null).title).toBe(
        "Draft the notes",
      );
    });
  });
});

describe("created thread navigation", () => {
  const ready: CodexCreatedThreadResolution = {
    hostId: "remote",
    threadId: "same",
    ready: true,
    parentThreadId: null,
  };
  const session: ProjectSession = {
    id: "session",
    projectId: null,
    noThreadFallbackTitle: "Chat",
    displayTitle: "Chat",
    activityAt: 0,
    managed: false,
    pinned: false,
    pinnedOrder: null,
    archived: false,
    archivedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    wokeAt: null,
    pageTurn: null,
    canManage: true,
    canStop: true,
    unread: false,
    createdAt: "now",
    updatedAt: "now",
    thread: {
      sessionId: "session",
      projectId: null,
      threadId: "same",
      executionHostId: "remote",
      backendBinding: { driver: "codex", instanceId: "codex" },
      threadPreview: "",
      statusType: "idle",
      statusActiveFlags: [],
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      linkedAt: "now",
    },
  };
  describe("host-qualified created chat navigation", () => {
    test("a source retired during its read cannot create or publish a Session", async () => {
      let current = true;
      const ensureOpen = vi.fn(async () => session);
      const navigation = await prepareCreatedThreadNavigation(
        { threadId: "same", expectedHostId: "remote" },
        {
          resolve: async () => {
            current = false;
            return ready;
          },
          ensureOpen,
          isCurrent: () => current,
        },
      );
      expect(navigation).toBeNull();
      expect(ensureOpen).not.toHaveBeenCalled();
      current = true;
      expect(
        await prepareCreatedThreadNavigation(
          { threadId: "same", expectedHostId: "remote" },
          {
            resolve: async () => ready,
            ensureOpen: async () => {
              current = false;
              return session;
            },
            isCurrent: () => current,
          },
        ),
      ).toBeNull();
    });
    test("foreign resolution performs no Session write", async () => {
      const ensureOpen = vi.fn(async () => session);
      expect(
        await prepareCreatedThreadNavigation(
          { threadId: "same", expectedHostId: "remote" },
          {
            resolve: async () => ({ ...ready, hostId: "local" }),
            ensureOpen,
          },
        ),
      ).toBeNull();
      expect(ensureOpen).not.toHaveBeenCalled();
    });
    test("an explicit missing root crosses the guarded command without inventing a read receipt", async () => {
      const ensureOpen = vi.fn(async () => session);
      expect(
        await prepareCreatedThreadNavigation(
          { threadId: "same", expectedHostId: "remote" },
          { resolve: async () => null, ensureOpen },
        ),
      ).toEqual({ type: "session", resolution: null, session });
      expect(ensureOpen).toHaveBeenCalledExactlyOnceWith({ hostId: "remote", threadId: "same" });
      expect(
        await prepareCreatedThreadNavigation(
          { threadId: "same", expectedHostId: "remote" },
          { resolve: async () => null, ensureOpen: async () => null },
        ),
      ).toBeNull();
    });
    test.each([
      { threadId: "same" },
      { clientThreadId: "client-new-thread:pending", expectedHostId: "remote" },
    ])("missing host or launch receipt cannot start discovery", async (input) => {
      const ensureOpen = vi.fn(async () => session);
      expect(
        await prepareCreatedThreadNavigation(input, { resolve: async () => null, ensureOpen }),
      ).toBeNull();
      expect(ensureOpen).not.toHaveBeenCalled();
    });
    test("a still-active launch cannot create a Session merely because its native ID exists", async () => {
      const ensureOpen = vi.fn(async () => session);
      const clientThreadId = "client-new-thread:pending";
      expect(
        await prepareCreatedThreadNavigation(
          { clientThreadId, expectedHostId: "remote" },
          {
            resolve: async () => ({ ...ready, clientThreadId, ready: false }),
            ensureOpen,
          },
        ),
      ).toEqual({ type: "pending", hostId: "remote", clientThreadId });
      expect(ensureOpen).not.toHaveBeenCalled();
    });
    test("parented children do not become root Sessions", async () => {
      const ensureOpen = vi.fn(async () => session);
      const resolution = { ...ready, parentThreadId: "root" };
      expect(
        await prepareCreatedThreadNavigation(
          { threadId: "same", expectedHostId: "remote" },
          {
            resolve: async () => resolution,
            ensureOpen,
          },
        ),
      ).toEqual({ type: "child", resolution });
      expect(ensureOpen).not.toHaveBeenCalled();
    });
    test("requires the returned Session to carry the exact Codex host and Thread", async () => {
      const input = { threadId: "same", expectedHostId: "remote" };
      const ensureOpen = vi.fn(async () => session);
      expect(
        await prepareCreatedThreadNavigation(input, { resolve: async () => ready, ensureOpen }),
      ).toEqual({ type: "session", resolution: ready, session });
      expect(ensureOpen).toHaveBeenCalledExactlyOnceWith({ hostId: "remote", threadId: "same" });
      expect(
        await prepareCreatedThreadNavigation(input, {
          resolve: async () => ready,
          ensureOpen: async () => ({
            ...session,
            thread: { ...session.thread!, executionHostId: "local" },
          }),
        }),
      ).toBeNull();
    });
  });
});

describe("hosted chat pictures", () => {
  beforeAll(() => {
    bindRendererSpace({
      spaceId: "team",
      kind: "team",
      memberId: "alice",
      deviceId: "desktop",
      name: "Crew",
      availability: "ready",
    });
  });

  const reply = (text: string) =>
    ({
      id: "reply",
      threadId: "root",
      runId: "run",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: "2026-11-08T09:00:00.000Z",
      updatedAt: "2026-11-08T09:00:00.000Z",
      completedAt: "2026-11-08T09:00:00.000Z",
      type: "assistant_message",
      messageId: "reply",
      text,
      streaming: false,
      attachments: [],
    }) as unknown as AgentTurnItem;

  const scope = conversationImageScope(
    {
      projectId: null,
      cwd: "/srv/crew",
      workspaceRoot: null,
      sourceRoot: { hostId: "local", threadId: "root" },
      hostId: "local",
      threadId: "root",
      sourceIdentity: "root:reply",
      authority: {},
      nativeConnection: { sourceEpoch: "epoch", transportKind: "stdio", generation: 1 },
      isCurrent: () => true,
      isResourceCurrent: () => true,
    },
    {},
  );

  describe("a chat on its Space's host", () => {
    test("shows each picture a reply names from a host file as one the host reads", () => {
      const projected = projectAgentRuntimeItem(
        reply("![Luna](/srv/crew/luna-star.png) and ![Web](https://example.com/web.png)"),
      );
      if (projected?.type !== "agentMessage") throw new Error("A reply is a reply");
      expect(
        projected.importedImages?.map(({ sourcePath, name, source }) => ({
          sourcePath,
          name,
          source: source && parseAgentRuntimeAttachmentSource(source),
        })),
      ).toEqual([
        {
          sourcePath: "/srv/crew/luna-star.png",
          name: "luna-star.png",
          source: {
            sourceThreadId: "root",
            itemId: "reply",
            attachmentId: "reply-picture:/srv/crew/luna-star.png",
          },
        },
      ]);
    });

    test("never reads a path in its transcript from this computer", async () => {
      for (const path of ["/srv/crew/luna-star.png", "luna-star.png", "file:///srv/crew/a.png"])
        expect(resolveConversationMediaTarget(path, scope)).toEqual({ kind: "blocked" });
      // Pictures on the web still load from there.
      expect(resolveConversationMediaTarget("https://example.com/web.png", scope)).toEqual({
        kind: "url",
        url: "https://example.com/web.png",
      });
      await expect(
        readContentImage(new QueryClient(), "/srv/crew/luna-star.png", scope),
      ).rejects.toThrow("Image file is unavailable");
    });
  });
});

describe("a hosted chat's Composer input", () => {
  test("uploads this computer's files and names them instead of their paths", () => {
    const pageLink = "nodex://page/space/page-1";
    const { promptInput, uploads } = separateHostedChatUploads({
      text: "Compare @report.pdf with the plan",
      documentItems: [
        { type: "text", text: "Compare " },
        { type: "mention", name: "report.pdf", path: "/Users/bob/report.pdf" },
        { type: "text", text: " with " },
        { type: "mention", name: "Plan", path: pageLink },
        { type: "skill", name: "review", path: "/srv/host/skills/review/SKILL.md" },
      ],
      fileAttachments: [
        { label: "notes.md", path: "notes.md", fsPath: "/Users/bob/notes.md" },
        { label: "report.pdf", path: "/Users/bob/report.pdf", fsPath: "/Users/bob/report.pdf" },
      ],
      addedFiles: [{ label: "data.csv", path: "C:\\data\\data.csv", fsPath: "" }],
      pageReferences: [],
    });
    expect(uploads).toEqual([
      { name: "notes.md", path: "/Users/bob/notes.md" },
      { name: "report.pdf", path: "/Users/bob/report.pdf" },
      { name: "data.csv", path: "C:\\data\\data.csv" },
    ]);
    // Pages and the host's own skills stay referenced exactly as written.
    expect(promptInput).toEqual({
      text: "Compare @report.pdf with the plan",
      documentItems: [
        { type: "text", text: "Compare " },
        { type: "text", text: "report.pdf" },
        { type: "text", text: " with " },
        { type: "mention", name: "Plan", path: pageLink },
        { type: "skill", name: "review", path: "/srv/host/skills/review/SKILL.md" },
      ],
      pageReferences: [],
    });
  });

  test("leaves input that names no file here unchanged", () => {
    const input = {
      text: "Summarize",
      mentions: [{ name: "Release chat", path: "thread://thread-1" }],
    };
    expect(separateHostedChatUploads(input)).toEqual({ promptInput: input, uploads: [] });
    expect(separateHostedChatUploads(undefined)).toEqual({ promptInput: undefined, uploads: [] });
  });
});

describe("new chat project selector", () => {
  function makeProject(input: {
    id: string;
    name: string;
    description?: string;
    primaryWorkspaceRoot?: string;
  }): Project {
    const primaryWorkspaceRoot = input.primaryWorkspaceRoot?.trim() || null;
    return {
      id: input.id,
      libraryId: "library:test",
      databaseId: "database:test:primary",
      defaultDatabaseViewId: "view:test:primary",
      lifecycle: "active",
      bindingRevision: 1,
      name: input.name,
      description: input.description ?? "",
      appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
      sources: primaryWorkspaceRoot
        ? [{ kind: "directory" as const, path: primaryWorkspaceRoot, order: 0 }]
        : [],
      primaryWorkspaceRoot,
      pinned: false,
      pinnedOrder: null,
      created: new Date("2026-06-07T00:00:00.000Z"),
      updated: new Date("2026-06-07T00:00:00.000Z"),
    };
  }

  describe("new-chat project selector options", () => {
    const options = buildNewChatProjectSelectorOptions([
      makeProject({
        id: "nodex",
        name: "Nodex",
        description: "Local-first agent orchestrator",
        primaryWorkspaceRoot: "/Users/asc/repo/nodex",
      }),
      makeProject({
        id: "devtools-codex",
        name: "Devtools Codex",
        primaryWorkspaceRoot: "/Users/asc/repo/devtools-codex",
      }),
      makeProject({
        id: "videos",
        name: "Videos",
        description: "Production scripts",
      }),
    ]);

    test("matches projects by display name", () => {
      const filtered = filterNewChatProjectSelectorOptions(options, "nodex");
      expect(filtered.length).toBe(1);
      expect(filtered[0]?.id).toBe("nodex");
    });

    test("matches projects by workspace path", () => {
      const filtered = filterNewChatProjectSelectorOptions(options, "devtools");
      expect(filtered.length).toBe(1);
      expect(filtered[0]?.id).toBe("devtools-codex");
    });

    test("returns all projects for empty search", () => {
      const filtered = filterNewChatProjectSelectorOptions(options, "   ");
      expect(filtered.length).toBe(3);
      expect(filtered[0]?.id).toBe("nodex");
      expect(filtered[2]?.id).toBe("videos");
    });

    test("preserves selected-project metadata", () => {
      const selected = resolveSelectedNewChatProjectSelectorOption(options, "devtools-codex");
      expect(selected?.label).toBe("Devtools Codex");
      expect(selected?.appearance).toEqual({
        color: "black",
        marker: { kind: "icon", icon: "folder" },
      });
      expect(selected?.primaryWorkspaceRoot).toBe("/Users/asc/repo/devtools-codex");
    });
  });
});
