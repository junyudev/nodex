import { describe, expect, test } from "vite-plus/test";
import type { PageTurn, TurnReason } from "../../shared/page-turn";
import { ordinal, pageTurnPhrase, type PageTurnHolder } from "./page-turn-phrase";

const turn = (
  reason: TurnReason | null,
  actor: PageTurn["actor"] = { kind: "member", member_id: "member" },
  hold: PageTurn["hold"] = null,
): PageTurn => ({ page_id: "page", actor, reason, since: "now", episode: "episode", hold });
const you: PageTurnHolder = { you: true, name: "You" };
const alice: PageTurnHolder = { you: false, name: "Alice" };
const codex: PageTurnHolder = { you: false, name: "Codex" };
const agent = {
  kind: "agent",
  assignee: { kind: "agent", instance_id: "codex", model: "gpt-6" },
} as const;

describe("one turn vocabulary", () => {
  test.each([
    ["question", "Needs your answer", "Waiting for Alice’s answer"],
    ["approval", "Needs your approval", "Waiting for Alice’s approval"],
    ["review", "Ready for your review", "Ready for Alice’s review"],
    ["blocked", "Blocked · needs you", "Blocked · needs Alice"],
    ["failed", "Failed · needs you", "Failed · needs Alice"],
    ["stalled", "Stalled · needs you", "Stalled · needs Alice"],
  ] as const)("%s names whose move it is", (reason, yours, theirs) => {
    expect(pageTurnPhrase(turn(reason), you)?.text).toBe(yours);
    expect(pageTurnPhrase(turn(reason), alice)?.text).toBe(theirs);
  });

  test("only what needs the reader asks for attention", () => {
    expect(pageTurnPhrase(turn("question"), you)?.tone).toBe("attention");
    expect(pageTurnPhrase(turn("review"), you)?.tone).toBe("attention");
    expect(pageTurnPhrase(turn("failed"), you)?.tone).toBe("danger");
    expect(pageTurnPhrase(turn("question"), alice)?.tone).toBe("quiet");
    expect(pageTurnPhrase(turn("failed"), alice)?.tone).toBe("quiet");
    expect(pageTurnPhrase(turn("ready_to_start"), you)?.tone).toBe("quiet");
  });

  test("reasons that do not wait on one person read the same for everyone", () => {
    expect(pageTurnPhrase(turn("working", agent), codex)?.text).toBe("Codex is working");
    expect(pageTurnPhrase(turn("working"), you)?.text).toBe("You’re working");
    expect(pageTurnPhrase(turn("working"), alice)?.text).toBe("Alice is working");
    expect(pageTurnPhrase(turn("starting", agent), codex)?.text).toBe("Codex is starting");
    expect(pageTurnPhrase(turn("queued", { kind: "queue", position: 2 }), you)?.text).toBe(
      "Queued · 2nd",
    );
    expect(pageTurnPhrase(turn("queued", agent), codex)?.text).toBe("Queued");
    expect(pageTurnPhrase(turn("ready_to_start"), alice)?.text).toBe("Ready to start");
    expect(
      pageTurnPhrase(
        turn("waiting_on_prerequisite", { kind: "page", page_id: "p", key: "NODEX-2" }),
        you,
      )?.text,
    ).toBe("Waiting for NODEX-2");
    expect(
      pageTurnPhrase(turn("waiting_on_prerequisite", { kind: "page", page_id: "p" }), you)?.text,
    ).toBe("Waiting for another Page");
  });

  test.each([
    [{ kind: "page", page_id: "page" }, you, "You paused this Page"],
    [{ kind: "project", project_id: "project" }, alice, "Alice paused this Project"],
    [{ kind: "space" }, you, "You paused all work"],
  ] as const)("a pause says who paused how much", (scope, holder, detail) => {
    const phrase = pageTurnPhrase(
      turn("paused", undefined, { scope, actor: "member", revision: 1, paused_at: "now" }),
      holder,
    );
    expect(phrase).toEqual({ text: "Paused", tone: "quiet", detail });
  });

  test("a Page without work has nothing to say", () => {
    expect(pageTurnPhrase(turn(null, { kind: "none" }), you)).toBeNull();
    expect(pageTurnPhrase(turn(null), you)).toBeNull();
  });

  test.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [4, "4th"],
    [11, "11th"],
    [12, "12th"],
    [13, "13th"],
    [21, "21st"],
    [112, "112th"],
  ])("formats queue position %s", (position, expected) =>
    expect(ordinal(Number(position))).toBe(expected),
  );
});
