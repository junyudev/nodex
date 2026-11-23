import { describe, expect, test } from "vite-plus/test";
import type { AgentMessageDisplay } from "@nodex/codex-app-server-protocol/v2";
import {
  codexAnswerModerationNotice,
  codexAnswerModerationText,
  codexAnswerModerationWithholdsText,
  codexReadableAnswerText,
} from "./codex-answer-moderation";

const moderated = (display: AgentMessageDisplay | null) => ({ moderated: true, display });

describe("codex answer moderation", () => {
  test.each([
    { name: "no verdict", moderation: null, notice: null, withholds: false },
    {
      name: "an unmoderated verdict",
      moderation: { moderated: false, display: null },
      notice: null,
      withholds: false,
    },
    {
      name: "a plain show",
      moderation: moderated({ mode: "show", version: 1, trustedContacts: "skip" }),
      notice: null,
      withholds: false,
    },
    {
      name: "a show with a helpline",
      moderation: moderated({
        mode: "show",
        version: 1,
        trustedContacts: "check",
        annotation: { kind: "wellbeingHelpline", subject: "answer" },
      }),
      notice: { kind: "helpline" },
      withholds: false,
    },
    {
      name: "a hide",
      moderation: moderated({
        mode: "hide",
        version: 1,
        replacement: { kind: "wellbeingPromptHelpline" },
      }),
      notice: { kind: "withheld" },
      withholds: true,
    },
    {
      name: "a cyber block",
      moderation: moderated({ mode: "block", version: 1, reason: { kind: "cyber" } }),
      notice: { kind: "blocked", reason: "cyber" },
      withholds: true,
    },
    {
      name: "a protection block",
      moderation: moderated({
        mode: "block",
        version: 1,
        reason: { kind: "protection", protectionType: "fixture" },
      }),
      notice: { kind: "blocked", reason: "protection" },
      withholds: true,
    },
  ])("presents $name", ({ moderation, notice, withholds }) => {
    const presented = codexAnswerModerationNotice(moderation);
    expect(presented).toEqual(notice);
    expect(codexAnswerModerationWithholdsText(presented)).toBe(withholds);
    const readable = codexReadableAnswerText({ text: "the answer", moderation });
    expect(readable).toBe(
      withholds && presented ? codexAnswerModerationText(presented) : "the answer",
    );
  });
});
