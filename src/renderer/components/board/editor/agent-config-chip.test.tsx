import { describe, expect, test } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import { act } from "react";
import { render, settleAsyncRender } from "@/test/dom";
import type { CodexModelOption } from "@/lib/types";
import {
  AgentConfigInlineContentView,
  buildAgentConfigResetUpdate,
  buildAgentConfigUpdate,
  normalizeAgentConfigProps,
  resolveAgentConfigChip,
  type AgentConfigInlineContentUpdate,
} from "./agent-config-chip";

const MODELS: CodexModelOption[] = [
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Frontier model.",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep" },
    ],
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  },
  {
    id: "hidden-model",
    model: "hidden-model",
    displayName: "Hidden",
    description: "Hidden model.",
    hidden: true,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
];

describe("agent config chip helpers", () => {
  test("resolves label and detail for valid config combinations", () => {
    const chip = resolveAgentConfigChip({
      mode: "plan",
      model: "gpt-5.5",
      reasoning: "high",
      unknownAttributes: "",
      rawAttributes: "",
    });

    expect(chip.label).toBe("Agent config");
    expect(chip.summary).toBe("Plan · GPT-5.5");
    expect(chip.detail).toBe("Plan · GPT-5.5 · High");
    expect(chip.invalid).toBe(false);
  });

  test("uses visible model display names in chip details", () => {
    const chip = resolveAgentConfigChip(
      {
        mode: "plan",
        model: "gpt-5.5",
        reasoning: "",
        unknownAttributes: "",
        rawAttributes: "",
      },
      MODELS,
    );

    expect(chip.summary).toBe("Plan · GPT-5.5");
  });

  test("marks invalid values and unknown attributes without dropping them", () => {
    const props = normalizeAgentConfigProps({
      mode: "planning",
      reasoning: "maximum",
      unknownAttributes: "mood",
      rawAttributes: 'mood="plan"',
    });
    const chip = resolveAgentConfigChip(props);

    expect(props.mode).toBe("planning");
    expect(props.rawAttributes).toBe('mood="plan"');
    expect(chip.label).toBe("Agent config");
    expect(chip.invalid).toBe(true);
  });

  test("field edits preserve untouched props and clear malformed metadata", () => {
    const update = buildAgentConfigUpdate(
      {
        mode: "plan",
        model: "gpt-5.5",
        reasoning: "high",
        unknownAttributes: "mood",
        rawAttributes: 'mood="plan"',
      },
      { mode: "default" },
    );

    expect(update.type).toBe("agentConfig");
    expect(update.props.mode).toBe("default");
    expect(update.props.model).toBe("gpt-5.5");
    expect(update.props.reasoning).toBe("high");
    expect(update.props.unknownAttributes).toBe("");
    expect(update.props.rawAttributes).toBe("");
  });

  test("reset returns malformed chips to the inherited default", () => {
    const update = buildAgentConfigResetUpdate();

    expect(update.props.mode).toBe("");
    expect(update.props.model).toBe("");
    expect(update.props.reasoning).toBe("");
    expect(update.props.unknownAttributes).toBe("");
    expect(update.props.rawAttributes).toBe("");
  });
});

describe("agent config chip popover", () => {
  test("uses the compact monochrome Nodex mark for agent identity", () => {
    const view = render(
      <AgentConfigInlineContentView
        inlineContent={{ props: { mode: "plan" } }}
        updateInlineContent={() => {}}
        availableModels={MODELS}
      />,
    );

    expect(view.container.querySelector('[data-nodex-logo-mark="monochrome"]')).not.toBeNull();
  });

  test("opens the editor popover from the chip", async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <AgentConfigInlineContentView
          inlineContent={{ props: { mode: "plan" } }}
          updateInlineContent={() => {}}
          availableModels={MODELS}
        />,
      );
    });

    await act(async () => {
      fireEvent.click(view.getByText("Agent config"));
      await settleAsyncRender();
    });

    const content = view.container.ownerDocument.body.querySelector(
      '[data-slot="popover-content"]',
    );
    expect(content).not.toBeNull();
    expect(content?.textContent?.includes("Applies only to this prompt send.")).toBe(true);
  });

  test("updates mode through the segmented control", async () => {
    const updates: AgentConfigInlineContentUpdate[] = [];
    const view = render(
      <AgentConfigInlineContentView
        inlineContent={{ props: { mode: "plan" } }}
        updateInlineContent={(update) => {
          updates.push(update);
        }}
        availableModels={MODELS}
        defaultOpen
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByText("Default"));
      await settleAsyncRender();
    });

    expect(updates[0]?.props.mode).toBe("default");
  });

  test("updates model through the model picker", async () => {
    const updates: AgentConfigInlineContentUpdate[] = [];
    const view = render(
      <AgentConfigInlineContentView
        inlineContent={{ props: { mode: "plan" } }}
        updateInlineContent={(update) => {
          updates.push(update);
        }}
        availableModels={MODELS}
        defaultOpen
      />,
    );

    const trigger = view.getByLabelText("Agent intelligence");
    expect(trigger.textContent).toBe("Use current/default");
    await act(async () => {
      fireEvent.click(trigger);
      await settleAsyncRender();
    });
    expect(
      view.getByRole("option", { name: "Use current/default" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(view.queryByRole("option", { name: "Hidden" })).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "GPT-5.5" }));
      await settleAsyncRender();
    });

    expect(updates[0]?.props.provider).toBe("openai");
    expect(updates[0]?.props.model).toBe("gpt-5.5");
  });

  test("returns an explicit model to the current/default choice", async () => {
    const updates: AgentConfigInlineContentUpdate[] = [];
    const view = render(
      <AgentConfigInlineContentView
        inlineContent={{ props: { mode: "plan", model: "gpt-5.5", reasoning: "high" } }}
        updateInlineContent={(update) => {
          updates.push(update);
        }}
        availableModels={MODELS}
        defaultOpen
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByLabelText("Agent intelligence"));
      await settleAsyncRender();
    });
    expect(view.getByRole("option", { name: "GPT-5.5" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Use current/default" }));
      await settleAsyncRender();
    });

    expect(updates[0]?.props).toMatchObject({ provider: "", model: "", reasoning: "", speed: "" });
  });

  test("updates reasoning on the effort slider", async () => {
    const updates: AgentConfigInlineContentUpdate[] = [];
    const view = render(
      <AgentConfigInlineContentView
        inlineContent={{ props: { mode: "plan", model: "gpt-5.5" } }}
        updateInlineContent={(update) => {
          updates.push(update);
        }}
        availableModels={MODELS}
        defaultOpen
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByLabelText("Agent intelligence"));
      await settleAsyncRender();
    });
    const effort = view.getByRole("slider", { name: "Effort" });
    expect(effort.getAttribute("aria-valuetext")).toBe("High");
    await act(async () => {
      fireEvent.keyDown(effort, { key: "ArrowLeft" });
      await settleAsyncRender();
    });

    expect(updates[0]?.props.reasoning).toBe("medium");
  });

  test("reset clears malformed props", async () => {
    const updates: AgentConfigInlineContentUpdate[] = [];
    const view = render(
      <AgentConfigInlineContentView
        inlineContent={{
          props: {
            mode: "planning",
            unknownAttributes: "mood",
            rawAttributes: 'mood="plan"',
          },
        }}
        updateInlineContent={(update) => {
          updates.push(update);
        }}
        availableModels={MODELS}
        defaultOpen
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByText("Reset"));
      await settleAsyncRender();
    });

    expect(updates[0]?.props.mode).toBe("");
    expect(updates[0]?.props.unknownAttributes).toBe("");
    expect(updates[0]?.props.rawAttributes).toBe("");
  });
});
