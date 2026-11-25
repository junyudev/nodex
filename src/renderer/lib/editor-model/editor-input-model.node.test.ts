import { describe, expect, test, it } from "vite-plus/test";
import {
  createDateMentionClockStore,
  getDelayUntilNextMinute,
  type DateMentionClockEnvironment,
} from "./date-mention-clock";
import {
  evaluateNfmTypedSuggestionTrigger,
  getNfmSlashTriggerCharacters,
  isNfmInlineSkillToken,
  shouldCloseNfmSkillQuery,
} from "./editor-trigger-policy";
import {
  selectMentionSuggestionSections,
  type MentionSuggestionFamily,
  type MentionSuggestionMatch,
} from "./mention-suggestion-model";
import {
  getNfmPageMentionEntryProfile,
  selectNfmPageMentionSections,
} from "./page-mention-entrypoint";
import type { CodexThreadSummary } from "@/lib/types";
import { resolveThreadMentionDisplay } from "./thread-mention-display";

describe("date mention clock", () => {
  type Listener = () => void;

  interface ScheduledTimer {
    id: number;
    callback: Listener;
    delayMs: number;
  }

  function createManualClock(start: string) {
    let currentNow = new Date(start);
    let nextTimerId = 1;
    let visible = true;
    const timers = new Map<number, ScheduledTimer>();
    const listeners = {
      document: new Map<string, Set<Listener>>(),
      window: new Map<string, Set<Listener>>(),
    };

    const addListener = (target: "document" | "window", type: string, listener: Listener) => {
      const targetListeners = listeners[target];
      const typeListeners = targetListeners.get(type) ?? new Set<Listener>();
      typeListeners.add(listener);
      targetListeners.set(type, typeListeners);
      return () => {
        typeListeners.delete(listener);
        if (typeListeners.size === 0) targetListeners.delete(type);
      };
    };

    const emit = (target: "document" | "window", type: string) => {
      Array.from(listeners[target].get(type) ?? []).forEach((listener) => listener());
    };

    const environment: DateMentionClockEnvironment = {
      now: () => new Date(currentNow.getTime()),
      setTimeout: (callback, delayMs) => {
        const id = nextTimerId;
        nextTimerId += 1;
        timers.set(id, { id, callback, delayMs });
        return id;
      },
      clearTimeout: (timer) => {
        timers.delete(timer as number);
      },
      addDocumentEventListener: (type, listener) => addListener("document", type, listener),
      addWindowEventListener: (type, listener) => addListener("window", type, listener),
      isDocumentVisible: () => visible,
    };

    return {
      environment,
      setNow: (value: string) => {
        currentNow = new Date(value);
      },
      setVisible: (value: boolean) => {
        visible = value;
      },
      emitDocument: (type: string) => emit("document", type),
      emitWindow: (type: string) => emit("window", type),
      runNextTimer: () => {
        const timer = Array.from(timers.values())[0];
        if (!timer) throw new Error("No scheduled timer");
        timers.delete(timer.id);
        timer.callback();
      },
      timerCount: () => timers.size,
      listenerCount: () => countListeners(listeners.document) + countListeners(listeners.window),
      firstTimerDelay: () => Array.from(timers.values())[0]?.delayMs ?? null,
    };
  }

  describe("date mention clock store", () => {
    test("notifies today subscribers only when the local day changes", () => {
      const clock = createManualClock("2026-06-28T12:00:00");
      const store = createDateMentionClockStore(clock.environment);
      const notifications: string[] = [];

      const unsubscribe = store.subscribeToday(() => {
        notifications.push(store.getTodayIsoSnapshot());
      });

      expect(store.getTodayIsoSnapshot()).toBe("2026-06-28");
      clock.setNow("2026-06-28T23:59:30");
      store.refresh();
      expect(notifications.length).toBe(0);

      clock.setNow("2026-06-29T00:00:02");
      store.refresh();
      expect(notifications.length).toBe(1);
      expect(notifications[0]).toBe("2026-06-29");

      unsubscribe();
      store.destroy();
    });

    test("schedules minute subscribers at the next minute boundary with a guard", () => {
      const clock = createManualClock("2026-06-28T12:34:10");
      const store = createDateMentionClockStore(clock.environment);
      const notifications: number[] = [];

      const unsubscribe = store.subscribeMinute(() => {
        notifications.push(store.getMinuteEpochSnapshot());
      });

      expect(clock.firstTimerDelay()).toBe(
        getDelayUntilNextMinute(new Date("2026-06-28T12:34:10")),
      );

      clock.setNow("2026-06-28T12:35:00.250");
      clock.runNextTimer();

      expect(notifications.length).toBe(1);
      expect(notifications[0]).toBe(new Date("2026-06-28T12:35:00").getTime());
      expect(clock.timerCount()).toBe(1);

      unsubscribe();
      store.destroy();
    });

    test("uses visibility and page lifecycle events to catch up delayed timers", () => {
      const clock = createManualClock("2026-06-28T23:58:00");
      const store = createDateMentionClockStore(clock.environment);
      const notifications: string[] = [];

      const unsubscribe = store.subscribeToday(() => {
        notifications.push(store.getTodayIsoSnapshot());
      });

      clock.setNow("2026-06-29T00:04:00");
      clock.emitDocument("visibilitychange");
      expect(notifications.length).toBe(1);
      expect(notifications[0]).toBe("2026-06-29");

      clock.setVisible(false);
      clock.setNow("2026-06-30T00:04:00");
      clock.emitWindow("focus");
      expect(notifications.length).toBe(1);

      clock.setVisible(true);
      clock.emitWindow("pageshow");
      expect(notifications.length).toBe(2);
      expect(notifications[1]).toBe("2026-06-30");

      unsubscribe();
      store.destroy();
    });

    test("does not silently advance an active lane when another lane subscribes", () => {
      const clock = createManualClock("2026-06-28T23:58:00");
      const store = createDateMentionClockStore(clock.environment);
      const todayNotifications: string[] = [];

      const unsubscribeToday = store.subscribeToday(() => {
        todayNotifications.push(store.getTodayIsoSnapshot());
      });
      clock.setNow("2026-06-29T00:04:00");

      const unsubscribeMinute = store.subscribeMinute(() => undefined);
      expect(store.getTodayIsoSnapshot()).toBe("2026-06-28");

      store.refresh();
      expect(todayNotifications.length).toBe(1);
      expect(todayNotifications[0]).toBe("2026-06-29");

      unsubscribeMinute();
      unsubscribeToday();
      store.destroy();
    });

    test("cleans timers and global listeners after the final unsubscribe", () => {
      const clock = createManualClock("2026-06-28T12:00:00");
      const store = createDateMentionClockStore(clock.environment);

      const unsubscribeToday = store.subscribeToday(() => undefined);
      const unsubscribeMinute = store.subscribeMinute(() => undefined);

      expect(clock.timerCount()).toBe(2);
      expect(clock.listenerCount()).toBe(3);

      unsubscribeToday();
      expect(clock.timerCount()).toBe(1);
      expect(clock.listenerCount()).toBe(3);

      unsubscribeMinute();
      expect(clock.timerCount()).toBe(0);
      expect(clock.listenerCount()).toBe(0);

      store.destroy();
    });
  });

  function countListeners(listeners: Map<string, Set<Listener>>): number {
    let count = 0;
    listeners.forEach((typeListeners) => {
      count += typeListeners.size;
    });
    return count;
  }
});

describe("editor trigger policy", () => {
  function evaluate(
    kind: Parameters<typeof evaluateNfmTypedSuggestionTrigger>[0]["kind"],
    trigger: string,
    textBeforeTrigger: string,
    locale = "en-US",
  ) {
    return evaluateNfmTypedSuggestionTrigger({
      kind,
      trigger,
      textBeforeTrigger,
      locale,
    });
  }

  describe("NFM typed suggestion trigger policy", () => {
    it("registers locale-appropriate slash triggers", () => {
      expect(getNfmSlashTriggerCharacters("en-US")).toEqual(["/", "／"]);
      expect(getNfmSlashTriggerCharacters("ja-JP")).toEqual(["/", "／", "；"]);
      expect(getNfmSlashTriggerCharacters("ja")).toEqual(["/", "／", "；"]);
    });

    it.each(["", "hello ", "hello\u00a0", "hello\u3000"])(
      "opens slash suggestions at a text boundary: %j",
      (textBeforeTrigger) => {
        expect(evaluate("slash", "/", textBeforeTrigger)).toEqual({ allowed: true });
      },
    );

    it.each(["abc", "7", "(", "-", "."])(
      "rejects slash suggestions inside a word or after an ASCII digit: %j",
      (textBeforeTrigger) => {
        expect(evaluate("slash", "/", textBeforeTrigger)).toMatchObject({
          allowed: false,
          reason: "invalid-left-boundary",
        });
      },
    );

    it("accepts the Japanese slash alias only in Japanese locales", () => {
      expect(evaluate("slash", "；", "", "ja-JP")).toEqual({ allowed: true });
      expect(evaluate("slash", "；", "", "en-US")).toMatchObject({
        allowed: false,
        reason: "unsupported-trigger",
      });
    });

    it.each(["http:", "http:/", "https:", "https:/"])(
      "keeps URL-like slash input literal: %j",
      (textBeforeTrigger) => {
        expect(evaluate("slash", "/", textBeforeTrigger)).toEqual({
          allowed: false,
          reason: "protected-literal",
        });
      },
    );

    it.each(["", "hello ", "hello(", "hello)", "hello[", "hello]"])(
      "opens mention suggestions at a supported boundary: %j",
      (textBeforeTrigger) => {
        expect(evaluate("page-mention", "@", textBeforeTrigger)).toEqual({ allowed: true });
      },
    );

    it("keeps word-adjacent mentions literal", () => {
      expect(evaluate("page-mention", "@", "hello")).toEqual({
        allowed: false,
        reason: "invalid-left-boundary",
      });
    });

    it.each(["hello.", "hello-"])("rejects unsupported mention punctuation: %j", (text) => {
      expect(evaluate("page-mention", "@", text)).toMatchObject({
        allowed: false,
        reason: "invalid-left-boundary",
      });
    });

    it.each(["hello（", "hello）", "hello［", "hello］"])(
      "normalizes fullwidth mention boundaries: %j",
      (text) => {
        expect(evaluate("page-mention", "@", text)).toEqual({ allowed: true });
      },
    );

    it.each(["", "hello ", "hello(", "hello)", "hello[", "hello]"])(
      "opens create-first Page mentions at a supported boundary: %j",
      (textBeforeTrigger) => {
        expect(evaluate("page-mention", "+", textBeforeTrigger)).toEqual({ allowed: true });
      },
    );

    it.each(["hello", "hello.", "7"])(
      "keeps word-adjacent create-first Page mentions literal: %j",
      (textBeforeTrigger) => {
        expect(evaluate("page-mention", "+", textBeforeTrigger)).toEqual({
          allowed: false,
          reason: "invalid-left-boundary",
        });
      },
    );

    it.each(["", "hello", "hello ", "hello["])(
      "opens wiki-link Page mentions whenever the bracket pair completes: %j",
      (textBeforeTrigger) => {
        expect(evaluate("page-mention", "[[", textBeforeTrigger)).toEqual({ allowed: true });
      },
    );

    it.each(["", "hello ", "hello{", "hello[", "hello("])(
      "opens emoji suggestions at a supported boundary: %j",
      (textBeforeTrigger) => {
        expect(evaluate("emoji", ":", textBeforeTrigger)).toEqual({ allowed: true });
      },
    );

    it("keeps word-adjacent emoji colons literal", () => {
      expect(evaluate("emoji", ":", "hello")).toEqual({
        allowed: false,
        reason: "invalid-left-boundary",
      });
    });

    it.each(["hello)", "hello]", "hello}"])(
      "rejects closing delimiters for emoji search: %j",
      (text) => {
        expect(evaluate("emoji", ":", text)).toMatchObject({
          allowed: false,
          reason: "invalid-left-boundary",
        });
      },
    );

    it("rejects trigger characters that do not belong to the requested menu", () => {
      expect(evaluate("slash", "；", "", "en-US")).toEqual({
        allowed: false,
        reason: "unsupported-trigger",
      });
      expect(evaluate("page-mention", "／", "")).toEqual({
        allowed: false,
        reason: "unsupported-trigger",
      });
    });
  });

  it("uses the invocation boundary and defers currency-shaped prefixes", () => {
    expect(evaluate("skill-mention", "$", "")).toEqual({ allowed: true });
    expect(evaluate("skill-mention", "$", "use ")).toEqual({ allowed: true });
    for (const prefix of ["name", "\\", "$", "("]) {
      expect(evaluate("skill-mention", "$", prefix).allowed).toBe(false);
    }

    const names = ["review", "5kit", "plugin:Review"];
    for (const query of ["", "5", "5k", "re", "plugin:"]) {
      expect(shouldCloseNfmSkillQuery(query, names)).toBe(false);
    }
    for (const query of ["5.00", "5m", "1e3", "HOME", "review,", "review ", "$"]) {
      expect(shouldCloseNfmSkillQuery(query, names)).toBe(true);
    }
    expect(isNfmInlineSkillToken("5k")).toBe(false);
    expect(isNfmInlineSkillToken("5kit")).toBe(true);
    expect(isNfmInlineSkillToken("plugin:Review")).toBe(true);
    expect(shouldCloseNfmSkillQuery("", [])).toBe(true);
  });
});

describe("mention suggestion model", () => {
  function candidate(
    value: string,
    family: MentionSuggestionFamily,
    match: MentionSuggestionMatch,
    sourceOrder: number,
    activeContext = false,
  ) {
    return {
      value,
      rank: { family, match, sourceOrder, activeContext },
    } as const;
  }

  describe("mention suggestion model", () => {
    test("puts Date first for an empty query and keeps each section bounded", () => {
      const candidates = [
        ...Array.from({ length: 12 }, (_, index) =>
          candidate(`page-${index}`, "page", "recent", index),
        ),
        ...Array.from({ length: 8 }, (_, index) =>
          candidate(`chat-${index}`, "chat", "recent", index, true),
        ),
        candidate("today", "temporal", "temporal_intent", 0),
        candidate("now", "temporal", "temporal_intent", 1),
      ];

      const sections = selectMentionSuggestionSections({ query: "", candidates });

      expect(sections.map(({ label }) => label)).toEqual([
        "Date",
        "Mention a page",
        "Mention a chat",
      ]);
      expect(sections[0]).toMatchObject({
        items: ["today", "now"],
        hiddenItemCount: 0,
      });
      expect(sections[1]).toMatchObject({
        items: ["page-0", "page-1", "page-2", "page-3", "page-4"],
        hiddenItemCount: 7,
      });
      expect(sections[2]).toMatchObject({
        items: ["chat-0", "chat-1", "chat-2"],
        hiddenItemCount: 5,
      });
    });

    test("orders queried sections by their strongest result", () => {
      const sections = selectMentionSuggestionSections({
        query: "today",
        candidates: [
          candidate("page-content", "page", "content", 0),
          candidate("page-title", "page", "title", 1),
          candidate("chat-exact", "chat", "exact_title", 0, true),
          candidate("today", "temporal", "temporal_intent", 0),
        ],
      });

      expect(sections.map(({ label }) => label)).toEqual([
        "Date",
        "Mention a chat",
        "Mention a page",
      ]);
      expect(sections[2]?.items).toEqual(["page-content", "page-title"]);
    });

    test("reports hidden results instead of letting one section dominate", () => {
      const sections = selectMentionSuggestionSections({
        query: "projection",
        candidates: Array.from({ length: 20 }, (_, index) =>
          candidate(`page-${index}`, "page", "title", index),
        ),
      });

      expect(sections).toHaveLength(1);
      expect(sections[0]?.items).toHaveLength(5);
      expect(sections[0]?.hiddenItemCount).toBe(15);
    });

    test("expands only the requested section", () => {
      const candidates = [
        ...Array.from({ length: 7 }, (_, index) =>
          candidate(`page-${index}`, "page", "title", index),
        ),
        ...Array.from({ length: 6 }, (_, index) =>
          candidate(`chat-${index}`, "chat", "title", index),
        ),
      ];

      const sections = selectMentionSuggestionSections({
        query: "result",
        candidates,
        expandedFamilies: new Set(["page"]),
      });

      expect(sections[0]).toMatchObject({
        family: "page",
        items: candidates.slice(0, 7).map(({ value }) => value),
        hiddenItemCount: 0,
      });
      expect(sections[1]).toMatchObject({
        family: "chat",
        items: ["chat-0", "chat-1", "chat-2", "chat-3"],
        hiddenItemCount: 2,
      });
    });

    test("preserves provider order and uses Page before Chat for a relevance tie", () => {
      const sections = selectMentionSuggestionSections({
        query: "weekly",
        candidates: [
          candidate("chat-later", "chat", "title", 8, true),
          candidate("page-first", "page", "title", 0, true),
          candidate("chat-first", "chat", "title", 0, true),
          candidate("page-later", "page", "title", 4, true),
        ],
      });

      expect(sections.map(({ family }) => family)).toEqual(["page", "chat"]);
      expect(sections[0]?.items).toEqual(["page-first", "page-later"]);
      expect(sections[1]?.items).toEqual(["chat-first", "chat-later"]);
    });
  });
});

describe("page mention entrypoint", () => {
  function candidate(
    value: string,
    family: MentionSuggestionFamily,
    match: MentionSuggestionMatch,
    sourceOrder: number,
  ) {
    return {
      value,
      rank: { family, match, sourceOrder, activeContext: false },
    } as const;
  }

  describe("NFM Page mention entry profiles", () => {
    test("owns the complete entry grammar", () => {
      expect(getNfmPageMentionEntryProfile("@")).toEqual({
        entry: "broad",
        trigger: "@",
        providers: ["page", "chat", "temporal", "create_page", "skill"],
        createPlacement: "after_broad_results",
        emptyQueryPopup: "show",
        temporaryInput: true,
      });
      expect(getNfmPageMentionEntryProfile("+")).toEqual({
        entry: "create_first",
        trigger: "+",
        providers: ["create_page", "page"],
        createPlacement: "before_page_results",
        emptyQueryPopup: "defer",
        temporaryInput: true,
      });
      expect(getNfmPageMentionEntryProfile("[[")).toEqual({
        entry: "wiki_link",
        trigger: "[[",
        providers: ["page", "create_page"],
        createPlacement: "after_page_results",
        emptyQueryPopup: "show",
        temporaryInput: true,
      });
    });

    test("keeps broad relevance sections ahead of Page creation", () => {
      const sections = selectNfmPageMentionSections({
        profile: getNfmPageMentionEntryProfile("@"),
        query: "today",
        rankedResults: [
          candidate("page", "page", "title", 0),
          candidate("chat", "chat", "exact_title", 0),
          candidate("today", "temporal", "temporal_intent", 0),
        ],
        createItems: ["create-current", "create-in"],
      });

      expect(sections.map(({ family }) => family)).toEqual([
        "temporal",
        "chat",
        "page",
        "create_page",
      ]);
      expect(sections.at(-1)).toEqual({
        family: "create_page",
        label: "New page",
        items: ["create-current", "create-in"],
        hiddenItemCount: 0,
      });
    });

    test("keeps create-first placement stable as Page results arrive", () => {
      const profile = getNfmPageMentionEntryProfile("+");
      const beforeResults = selectNfmPageMentionSections({
        profile,
        query: "roadmap",
        rankedResults: [],
        createItems: ["create-current", "create-in"],
      });
      const afterResults = selectNfmPageMentionSections({
        profile,
        query: "roadmap",
        rankedResults: [
          candidate("page-1", "page", "exact_title", 0),
          candidate("chat-must-not-leak", "chat", "exact_title", 0),
        ],
        createItems: ["create-current", "create-in"],
      });

      expect(beforeResults.map(({ family }) => family)).toEqual(["create_page"]);
      expect(afterResults.map(({ family }) => family)).toEqual(["create_page", "page"]);
      expect(afterResults[0]?.label).toBeNull();
    });

    test("keeps wiki-link Page results ahead of creation", () => {
      const sections = selectNfmPageMentionSections({
        profile: getNfmPageMentionEntryProfile("[["),
        query: "roadmap",
        rankedResults: [
          candidate("page-1", "page", "exact_title", 0),
          candidate("temporal-must-not-leak", "temporal", "temporal_intent", 0),
        ],
        createItems: ["create-current", "create-in"],
      });

      expect(sections.map(({ family }) => family)).toEqual(["page", "create_page"]);
      expect(sections.at(-1)?.label).toBeNull();
    });
  });
});

describe("thread mention display", () => {
  const thread = (overrides: Partial<CodexThreadSummary> = {}): CodexThreadSummary => ({
    threadId: "thread-mention",
    projectId: "project-1",
    source: null,
    threadName: null,
    threadPreview: "",
    modelProvider: "openai",
    cwd: null,
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    linkedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  describe("resolveThreadMentionDisplay", () => {
    test("projects stored Markdown before presenting a thread label", () => {
      expect(
        resolveThreadMentionDisplay({
          uuid: "thread-mention",
          thread: thread({ threadName: "**Review** [changes](https://example.com)" }),
        }).label,
      ).toBe("Review changes");
    });
  });
});
