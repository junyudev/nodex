import { describe, expect, test } from "vite-plus/test";
import {
  buildAutomationHeartbeatPrompt,
  parseAutomationHeartbeatPrompt,
  parseAutomationHeartbeatReply,
  projectAutomationHeartbeatExcerpt,
  projectAutomationHeartbeatReply,
} from "./automation-heartbeat";

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
