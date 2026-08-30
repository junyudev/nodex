import { describe, expect, test, vi } from "vite-plus/test";
import {
  collectCodexPromptAgentConfigs,
  prepareCodexPrompt,
  splitCodexPromptAgentConfigLines,
} from "./codex-prompt-preparation";

describe("Codex prompt preparation", () => {
  test("keeps pasted text as a bounded sidecar until the main command boundary", async () => {
    const resolveImageInput = vi.fn(async (source: string) => ({
      type: "localImage" as const,
      path: `/resolved/${source.split("/").at(-1)}`,
    }));
    const prepared = await prepareCodexPrompt(
      "ignored fallback",
      {
        text: "ship the fix",
        textAttachments: [{ text: "pasted context" }],
        fileAttachments: [
          {
            label: "store.ts",
            path: "src/store.ts",
            fsPath: "/workspace/src/store.ts",
          },
        ],
        addedFiles: [
          {
            label: "store.ts duplicate",
            path: "src/store.ts",
            fsPath: "/workspace/src/store.ts",
          },
        ],
        images: [{ source: "nodex://assets/diagram.png" }],
        mentions: [
          {
            name: "Browser",
            path: "plugin://browser@openai-bundled",
          },
        ],
        skills: [{ name: "feature-dev", path: "/skills/feature-dev" }],
        commentAttachments: [
          {
            id: "comment-1",
            type: "comment",
            content: [{ content_type: "text", text: "Keep the identity stable" }],
            position: { side: "right", path: "src/store.ts", line: 42 },
            createdAt: 1,
          },
        ],
        browserAnnotationAttachments: [
          {
            schemaVersion: 1,
            id: "browser-comment-1",
            browserTabId: "browser-tab-1",
            createdAt: 2,
            note: "Make this action more prominent",
            pageTitle: "Checkout",
            pageUrl: "https://example.com/checkout",
            anchors: [
              {
                id: "anchor-1",
                kind: "element",
                pageUrl: "https://example.com/checkout",
                selector: "main > button",
                rect: { x: 40, y: 80, width: 120, height: 32 },
              },
            ],
            evidence: {
              attachmentId: "browser-evidence.png",
              source: "nodex://assets/browser-evidence.png",
              mimeType: "image/png",
              width: 168,
              height: 80,
            },
          },
        ],
      },
      { resolveImageInput },
    );

    expect(resolveImageInput).toHaveBeenCalledWith("nodex://assets/diagram.png");
    expect(resolveImageInput).toHaveBeenCalledWith("nodex://assets/browser-evidence.png");
    expect(prepared.inputItems.map((item) => item.type)).toEqual([
      "text",
      "text",
      "text",
      "localImage",
      "localImage",
      "mention",
      "mention",
      "skill",
    ]);
    expect(prepared.inputItems.filter((item) => item.type === "mention")).toEqual([
      {
        type: "mention",
        name: "Browser",
        path: "plugin://browser@openai-bundled",
      },
      {
        type: "mention",
        name: "store.ts",
        path: "src/store.ts",
      },
    ]);
    expect(prepared.additionalContext?.["review-diff-comments"]?.kind).toBe("application");
    expect(prepared.additionalContext?.["browser-annotations"]?.kind).toBe("application");
    expect(prepared.pendingInputItems.map((item) => item.type)).toEqual([
      "text",
      "text",
      "text",
      "localImage",
      "localImage",
      "mention",
      "skill",
    ]);
    expect(prepared.pendingInputItems.find((item) => item.type === "mention")).toEqual({
      type: "mention",
      name: "Browser",
      path: "plugin://browser@openai-bundled",
    });
    expect(prepared.pastedTextAttachments).toEqual([{ text: "pasted context" }]);
  });

  test("extracts inline agent config without sending it as prompt text", () => {
    const parsed = splitCodexPromptAgentConfigLines(
      [
        "Investigate the owner path",
        '<agent-config mode="plan" provider="openai" model="gpt-test" reasoning="high" speed="fast" permission="auto" />',
      ].join("\n"),
    );

    expect(parsed.text).toBe("Investigate the owner path");
    expect(parsed.agentConfigs).toEqual([
      {
        mode: "plan",
        provider: "openai",
        model: "gpt-test",
        reasoning: "high",
        speed: "fast",
        permission: "auto",
      },
    ]);
  });

  test("collects structured Agent config sidecars without scanning fallback text", () => {
    const structured = [{ provider: "anthropic", model: "claude-sonnet" }];
    expect(
      collectCodexPromptAgentConfigs('<agent-config provider="openai" />', {
        text: "Do the work",
        agentConfigs: structured,
      }),
    ).toEqual(structured);
    expect(
      collectCodexPromptAgentConfigs('<agent-config provider="openai" speed="fast" />', undefined),
    ).toEqual([{ provider: "openai", speed: "fast" }]);
  });

  test("keeps app and chat mentions structured in both live and pending input", async () => {
    const prepared = await prepareCodexPrompt(
      "",
      {
        text: "",
        mentions: [
          {
            name: "plugin-management",
            path: "app://plugin-management",
          },
          {
            name: "Browser parity",
            path: "thread://thread-1",
          },
        ],
      },
      {
        resolveImageInput: vi.fn(async () => ({
          type: "localImage" as const,
          path: "/unused",
        })),
      },
    );

    expect(prepared.inputItems).toEqual([
      {
        type: "mention",
        name: "plugin-management",
        path: "app://plugin-management",
      },
      {
        type: "mention",
        name: "Browser parity",
        path: "thread://thread-1",
      },
    ]);
    expect(prepared.pendingInputItems).toEqual(prepared.inputItems);
    expect(prepared.fileAttachments).toEqual([]);
  });

  test("attaches Appshot pixels and application context as one prompt unit", async () => {
    const resolveImageInput = vi.fn(async (source: string) => ({
      type: "localImage" as const,
      path:
        source === "data:image/png;base64,YXBwc2hvdA=="
          ? "/resolved/Safari Appshot.png"
          : "/resolved/other.png",
    }));
    const prepared = await prepareCodexPrompt(
      "",
      {
        text: "Inspect the current app",
        appshots: [
          {
            id: "appshot-1",
            appName: "Safari & Preview",
            bundleIdentifier: "com.apple.Safari",
            windowTitle: 'Plans <2026> "final"',
            axTree: "AXWindow\n  AXButton title=<Continue & save>",
            imageName: "Safari Appshot.png",
            imageDataUrl: "data:image/png;base64,YXBwc2hvdA==",
            appIconDataUrl: null,
          },
        ],
      },
      { resolveImageInput },
    );

    expect(resolveImageInput).toHaveBeenCalledTimes(1);
    expect(resolveImageInput).toHaveBeenCalledWith("data:image/png;base64,YXBwc2hvdA==");
    expect(prepared.inputItems).toEqual([
      {
        type: "text",
        text: "Inspect the current app",
        text_elements: [],
      },
      {
        type: "localImage",
        path: "/resolved/Safari Appshot.png",
      },
    ]);
    expect(prepared.pendingInputItems).toEqual(prepared.inputItems);
    expect(prepared.additionalContext?.appshots).toEqual({
      kind: "application",
      value: [
        "# Applications mentioned by the user:",
        "",
        '<appshot app="Safari &amp; Preview" bundle-identifier="com.apple.Safari" window-title="Plans &lt;2026&gt; &quot;final&quot;" image="Safari Appshot.png">',
        "AXWindow",
        "  AXButton title=&lt;Continue &amp; save&gt;",
        "</appshot>",
      ].join("\n"),
    });
  });

  test("preserves composer document order without demoting file mentions", async () => {
    const prepared = await prepareCodexPrompt(
      "",
      {
        text: "Open  before using ",
        documentItems: [
          {
            type: "text",
            text: "Open ",
          },
          {
            type: "mention",
            name: "notes.md",
            path: "docs/notes.md",
          },
          {
            type: "text",
            text: " before using ",
          },
          {
            type: "skill",
            name: "PDF",
            path: "/skills/pdf/SKILL.md",
          },
        ],
        mentions: [
          {
            name: "notes.md",
            path: "docs/notes.md",
          },
        ],
        skills: [
          {
            name: "PDF",
            path: "/skills/pdf/SKILL.md",
          },
        ],
      },
      {
        resolveImageInput: vi.fn(async () => ({
          type: "localImage" as const,
          path: "/unused",
        })),
      },
    );

    expect(prepared.inputItems).toEqual([
      {
        type: "text",
        text: "Open ",
        text_elements: [],
      },
      {
        type: "mention",
        name: "notes.md",
        path: "docs/notes.md",
      },
      {
        type: "text",
        text: " before using ",
        text_elements: [],
      },
      {
        type: "skill",
        name: "PDF",
        path: "/skills/pdf/SKILL.md",
      },
    ]);
    expect(prepared.pendingInputItems).toEqual(prepared.inputItems);
    expect(prepared.fileAttachments).toEqual([]);
  });
});
