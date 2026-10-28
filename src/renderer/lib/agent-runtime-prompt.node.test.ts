import { describe, expect, it, vi } from "vite-plus/test";
import {
  agentRuntimeImageInputSupport,
  agentRuntimePromptImages,
  prepareAgentRuntimeMessage,
} from "./agent-runtime-prompt";
import type { CodexPromptInput } from "../../shared/types";
import type { CodexUntrustedAppMessage } from "../../shared/codex-untrusted-app-input";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";

const image = "data:image/png;base64,aW1hZ2U=";
const model = (inputModalities?: ("text" | "image")[]) => ({
  slug: "model",
  name: "Model",
  isCustom: false,
  capabilities: { optionDescriptors: [], ...(inputModalities ? { inputModalities } : {}) },
});
const imageInputs: {
  name: string;
  promptInput?: CodexPromptInput;
  untrustedAppMessage?: CodexUntrustedAppMessage;
}[] = [
  { name: "attached image", promptInput: { text: "Look", images: [{ source: image }] } },
  {
    name: "appshot",
    promptInput: {
      text: "Look",
      appshots: [
        {
          id: "shot",
          appName: "Example",
          bundleIdentifier: "example",
          windowTitle: null,
          axTree: "",
          imageName: "Window",
          imageDataUrl: image,
          appIconDataUrl: null,
        },
      ],
    },
  },
  {
    name: "application context",
    promptInput: {
      text: "Look",
      mcpAppModelContextAttachments: [
        {
          id: "context",
          title: "Preview",
          untrusted: true,
          content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
        },
      ],
    },
  },
  {
    name: "application message",
    untrustedAppMessage: {
      source: "visualization",
      sourceId: "preview",
      text: "Look",
      imageUrls: [image],
    },
  },
];

describe("Runtime visual input admission", () => {
  it.each(["structured", "raw", "editor-text", "document-items"])(
    "validates the effective %s Agent config model before completing preparation",
    async (source) => {
      const textModel = { ...model(["text"]), slug: "text" };
      const visionModel = { ...model(["text", "image"]), slug: "vision" };
      const provider = {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        version: "test",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-22T00:00:00.000Z",
        slashCommands: [],
        skills: [],
        models: [textModel, visionModel],
      } satisfies AgentRuntimeOperations["providers.read"]["output"][number];
      const prepare = (from: typeof textModel, to: string) => {
        const text = source === "structured" ? "Look" : `Look\n:agent-config{model="${to}"}`;
        const input = {
          model: from,
          provider,
          modelSelection: { instanceId: "codex", model: from.slug },
          kind: "codex" as const,
          text,
          ...(source === "structured"
            ? { promptInput: { text, images: [{ source: image }], agentConfigs: [{ model: to }] } }
            : source === "document-items"
              ? {
                  promptInput: {
                    text: "Look",
                    documentItems: [{ type: "text" as const, text }],
                    images: [{ source: image }],
                  },
                }
              : source === "editor-text"
                ? { promptInput: { text, images: [{ source: image }] } }
                : {
                    untrustedAppMessage: {
                      source: "visualization" as const,
                      sourceId: "view",
                      text: "Image",
                      imageUrls: [image],
                    },
                  }),
        };
        return prepareAgentRuntimeMessage(input, vi.fn());
      };
      await expect(prepare(textModel, "vision")).resolves.toHaveProperty("text");
      await expect(prepare(visionModel, "text")).rejects.toThrow("does not support image");
    },
  );
  it("keeps an explicit empty editor config list authoritative", async () => {
    const text = 'Look\n\n:agent-config{model="text"}';
    await expect(
      prepareAgentRuntimeMessage(
        {
          model: model(["text", "image"]),
          kind: "codex",
          text,
          promptInput: { text, images: [{ source: image }], agentConfigs: [] },
        },
        vi.fn(),
      ),
    ).resolves.toEqual({ text });
  });
  it("distinguishes explicit text-only from unreported capability", () => {
    expect(agentRuntimeImageInputSupport(undefined)).toBe("unknown");
    expect(agentRuntimeImageInputSupport(model())).toBe("unknown");
    expect(agentRuntimeImageInputSupport(model(["text"]))).toBe("unsupported");
    expect(agentRuntimeImageInputSupport(model(["text", "image"]))).toBe("supported");
  });

  it.each(imageInputs)(
    "checks $name before preparing a message",
    async ({ promptInput, untrustedAppMessage }) => {
      const read = vi.fn();
      const input = { kind: "opencode" as const, text: "Look", promptInput, untrustedAppMessage };
      await expect(
        prepareAgentRuntimeMessage({ ...input, model: model(["text"]) }, read),
      ).rejects.toThrow("does not support image");
      await expect(prepareAgentRuntimeMessage({ ...input, model: model() }, read)).rejects.toThrow(
        "has not reported image",
      );
      await expect(
        prepareAgentRuntimeMessage({ ...input, model: model(["text", "image"]) }, read),
      ).resolves.toHaveProperty("text");
      expect(agentRuntimePromptImages(promptInput, untrustedAppMessage)).toEqual([
        expect.objectContaining({ source: image }),
      ]);
      expect(read).not.toHaveBeenCalled();
    },
  );
});
