import { expect, test, describe } from "vite-plus/test";
import {
  buildAgentRuntimeAttachmentSource,
  parseAgentRuntimeAttachmentSource,
} from "./agent-runtime-attachments";
import {
  agentRuntimeSubagentAgent,
  projectAgentRuntimeSubagentDisplay,
} from "./agent-runtime-subagent-display";
import { AGENT_TOOL_OUTPUT_MAX_BYTES, boundAgentToolOutput } from "./agent-tool-output";

describe("agent runtime attachments", () => {
  test("attachment descriptors preserve original item identity without manufacturing a filesystem path", () => {
    const reference = {
      sourceThreadId: "source/thread",
      itemId: "user:item/1",
      attachmentId: "image-asset",
    };
    expect(parseAgentRuntimeAttachmentSource(buildAgentRuntimeAttachmentSource(reference))).toEqual(
      reference,
    );
    expect(parseAgentRuntimeAttachmentSource("nodex-runtime-image:source/item/%zz")).toBeNull();
    expect(
      parseAgentRuntimeAttachmentSource("nodex-runtime-image:source/item/image/extra"),
    ).toBeNull();
    expect(parseAgentRuntimeAttachmentSource("nodex-runtime-image:source/item/%00")).toBeNull();
    expect(parseAgentRuntimeAttachmentSource("/tmp/attachment.png")).toBeNull();
  });
});

describe("Runtime subagent display names", () => {
  test("attributes Antigravity child work to its own harness and native thinking option", () => {
    expect(
      agentRuntimeSubagentAgent({
        driver: "antigravity",
        providerInstanceId: "google",
        model: "gemini",
        modelSelection: {
          instanceId: "google",
          model: "gemini",
          options: [{ id: "thought_level", value: "high" }],
        },
      }),
    ).toEqual({
      kind: "antigravity",
      providerInstanceId: "google",
      model: "gemini",
      effort: "high",
    });
  });

  test("presents the last native path segment and retains the complete path", () => {
    expect(
      projectAgentRuntimeSubagentDisplay({
        driver: "codex",
        origin: "provider_native",
        title: " /root/review_team/reference_bundle ",
      }),
    ).toEqual({
      displayName: "Reference bundle",
      agentPath: "/root/review_team/reference_bundle",
    });
  });

  test.each([
    { driver: "codex", origin: "app_owned", title: "/root/reference_bundle" },
    { driver: "claudeAgent", origin: "provider_native", title: "/root/reference_bundle" },
    { driver: "codex", origin: "provider_native", title: "UI/API audit" },
    { driver: "codex", origin: "provider_native", title: "Inspect /root/reference_bundle" },
    { driver: "codex", origin: "provider_native", title: "Ada" },
  ] as const)("preserves names that are not Codex native paths: $title", (source) => {
    expect(projectAgentRuntimeSubagentDisplay(source)).toEqual({
      displayName: source.title,
      agentPath: null,
    });
  });

  test("leaves an absent name available for the surface's fallback", () => {
    expect(
      projectAgentRuntimeSubagentDisplay({
        driver: "codex",
        origin: "provider_native",
        title: " ",
      }),
    ).toEqual({ displayName: null, agentPath: null });
  });
});

describe("agent tool output", () => {
  test("lazy tool output preserves complete UTF-8 text and reports its independent byte budget", () => {
    const text = "Workspace\n".repeat(8_000);
    expect(boundAgentToolOutput(text)).toEqual({
      text,
      truncated: false,
      originalBytes: new TextEncoder().encode(text).length,
    });
    const oversized = `${"a".repeat(AGENT_TOOL_OUTPUT_MAX_BYTES - 1)}🧪tail`;
    const clipped = boundAgentToolOutput(oversized);
    expect(clipped).toMatchObject({
      truncated: true,
      originalBytes: AGENT_TOOL_OUTPUT_MAX_BYTES + 7,
    });
    expect(clipped.text.endsWith("a")).toBe(true);
    expect(clipped.text).not.toContain("�");
    expect(new TextEncoder().encode(clipped.text).length).toBeLessThanOrEqual(
      AGENT_TOOL_OUTPUT_MAX_BYTES,
    );
  });
});
