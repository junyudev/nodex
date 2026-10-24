import { describe, expect, test } from "vite-plus/test";
import { toDesktopNotificationPlainText } from "./desktop-notification-text";
import { resolveCodexTurnNotificationBody } from "./codex-thread-notification";
import { parseCodexHeartbeatAssistantMessage } from "./codex-turn-notification";

describe("desktop notification plain text", () => {
  test("removes executable HTML, tags, markdown decoration, and line breaks", () => {
    expect(
      toDesktopNotificationPlainText(
        [
          "# **Done**",
          "<script>alert('secret')</script>",
          "<style>.hidden { color: red }</style>",
          "Read [the report](https://example.com) &amp; continue.<br>Now.",
        ].join("\n"),
      ),
    ).toBe("Done Read the report & continue. Now.");
  });

  test("decodes entities and retains the complete reply for native presentation", () => {
    expect(toDesktopNotificationPlainText("A &#x1f680; B &#67;")).toBe("A 🚀 B C");
    expect(toDesktopNotificationPlainText(null)).toBe("");
    const reply = "已完成 🚀 ".repeat(150).trim();
    expect(toDesktopNotificationPlainText(reply)).toBe(reply);
    expect(() => toDesktopNotificationPlainText("&#x110000;")).not.toThrow();
  });

  test.each(["reply", "heartbeat-message", "heartbeat-visible"])(
    "%s preserves fenced code and following content until native delivery",
    (source) => {
      const markdown = "## Result\n```ts\nconst value_name = 1;\n```\nAll checks passed.";
      const lastAgentMessage =
        source === "reply"
          ? markdown
          : source === "heartbeat-message"
            ? `<heartbeat><decision>NOTIFY</decision><message>${markdown}</message></heartbeat>`
            : `${markdown}\n<heartbeat><decision>NOTIFY</decision></heartbeat>`;
      const body = resolveCodexTurnNotificationBody({
        lastAgentMessage,
        heartbeatAssistantMessage: parseCodexHeartbeatAssistantMessage(lastAgentMessage),
      });
      expect(toDesktopNotificationPlainText(body)).toBe(
        "Result const value_name = 1; All checks passed.",
      );
    },
  );

  test("keeps readable links and code while omitting private citation and directive payloads", () => {
    expect(
      toDesktopNotificationPlainText(
        [
          "**Done.** Use `Map<Key, Value>` and `file_name`.",
          "Read [the report](https://example.com/report_(final)).",
          "Evidence \uE200cite\uE202private-source\uE201 checked.",
          '::codex-followup[Continue]{prompt="private prompt"}',
          '::codex-inline-vis{file="private.html"}',
        ].join("\n\n"),
      ),
    ).toBe("Done. Use Map<Key, Value> and file_name. Read the report. Evidence checked. Continue");
  });
});
