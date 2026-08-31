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

    expect(chip.label).toBe("Plan mode");
    expect(chip.detail).toBe("GPT-5.5 · High");
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

    expect(chip.detail).toBe("GPT-5.5");
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
    expect(chip.label).toBe("Invalid config");
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

  test("reset returns malformed chips to a valid plan-mode default", () => {
    const update = buildAgentConfigResetUpdate();

    expect(update.props.mode).toBe("plan");
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
      fireEvent.click(view.getByText("Plan mode"));
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

    await act(async () => {
      const trigger = view.getByLabelText("Agent config model");
      fireEvent.click(trigger);
      await settleAsyncRender();
    });
    const search = view.getByRole("combobox", { name: "Search agent models" });
    await act(async () => {
      fireEvent.change(search, { target: { value: "5.5" } });
      fireEvent.click(view.getByRole("option", { name: /GPT-5\.5/u }));
      await settleAsyncRender();
    });

    expect(updates[0]?.props.model).toBe("gpt-5.5");
  });

  test("updates reasoning through the reasoning picker", async () => {
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
      const trigger = view.getByLabelText("Agent config reasoning");
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await settleAsyncRender();
    });
    await act(async () => {
      fireEvent.click(view.getByText("High"));
      await settleAsyncRender();
    });

    expect(updates[0]?.props.reasoning).toBe("high");
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

    expect(updates[0]?.props.mode).toBe("plan");
    expect(updates[0]?.props.unknownAttributes).toBe("");
    expect(updates[0]?.props.rawAttributes).toBe("");
  });
});
