import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CodexModelOption } from "@/lib/types";
import {
  AgentConfigInlineContentView,
  type AgentConfigInlineContentUpdate,
  type AgentConfigProps,
} from "./agent-config-chip";

const STORY_MODELS: CodexModelOption[] = [
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Frontier model.",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep reasoning" },
      { reasoningEffort: "xhigh", description: "Maximum reasoning" },
    ],
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  },
  {
    id: "gpt-5.5-enterprise-preview-with-extended-context",
    model: "gpt-5.5-enterprise-preview-with-extended-context",
    displayName: "GPT-5.5 Enterprise Preview With Extended Context",
    description: "Long-context preview model.",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep reasoning" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
];

function AgentConfigChipStorySurface({
  initialProps,
  open = true,
}: {
  initialProps: Partial<AgentConfigProps>;
  open?: boolean;
}) {
  const [props, setProps] = useState<Partial<AgentConfigProps>>(initialProps);

  return (
    <div className="max-w-xl rounded-lg bg-token-bg-fog p-3 text-token-foreground">
      <span className="text-sm text-token-foreground">
        Review first{" "}
        <AgentConfigInlineContentView
          inlineContent={{ props }}
          updateInlineContent={(update: AgentConfigInlineContentUpdate) => {
            setProps(update.props);
          }}
          availableModels={STORY_MODELS}
          defaultOpen={open}
        />{" "}
        then continue with the prompt.
      </span>
    </div>
  );
}

const meta = {
  title: "Board/Editor/Agent Config Chip",
  component: AgentConfigChipStorySurface,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Focused coverage for editable NFM agent config chips rendered from the canonical `<agent-config />` inline element.",
      },
    },
  },
} satisfies Meta<typeof AgentConfigChipStorySurface>;

export default meta;

type Story = StoryObj<typeof meta>;

export const PlanModeOpen: Story = {
  args: {
    initialProps: { mode: "plan" },
    open: true,
  },
};

export const ModelAndReasoningOpen: Story = {
  args: {
    initialProps: { model: "gpt-5.5", reasoning: "high" },
    open: true,
  },
};

export const CombinedLongModelOpen: Story = {
  args: {
    initialProps: {
      mode: "plan",
      model: "gpt-5.5-enterprise-preview-with-extended-context",
      reasoning: "high",
    },
    open: true,
  },
};

export const InvalidStateOpen: Story = {
  args: {
    initialProps: {
      mode: "planning",
      unknownAttributes: "mood",
      rawAttributes: 'mood="plan"',
    },
    open: true,
  },
};

export const EmptyInheritStateOpen: Story = {
  args: {
    initialProps: {},
    open: true,
  },
};
