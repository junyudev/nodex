import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Layers3, SlidersHorizontal } from "@/components/shared/icons/generic-icons";
import { ResetIcon } from "@/components/shared/icons";
import { ToggleListRulesBody, ToggleListSummaryBadges } from "./toggle-list-rules-body";
import { PROJECTION_ACTION_BTN } from "./editor/projection-drag-handle";
import { NodexDropdownButtonTrigger, NodexOptionPicker } from "@/components/ui/dropdown";
import { getDefaultToggleListSettings } from "@/lib/toggle-list/settings";
import type { ToggleListSettings } from "@/lib/toggle-list/types";
import { cn } from "@/lib/utils";

const AVAILABLE_TAGS = ["cal", "manual", "sidebar", "simple", "thread", "to reproduce"];
const PROJECT_OPTIONS = [
  { value: "default", label: "Nodex" },
  { value: "bundle", label: "Codex bundle" },
  { value: "scratch", label: "Scratchpad" },
];

function StorySurface({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-(--background) p-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 rounded-[20px] border border-(--border) bg-(--card) p-5">
        {children}
      </div>
    </div>
  );
}

function ToggleListRulesStory({ compact = false }: { compact?: boolean }) {
  const [settings, setSettings] = useState<ToggleListSettings>(() =>
    getDefaultToggleListSettings(),
  );

  return (
    <StorySurface>
      <ToggleListSummaryBadges settings={settings} visibleCount={12} />
      <ToggleListRulesBody
        settings={settings}
        availableTags={AVAILABLE_TAGS}
        updateSettings={(updater) => setSettings((current) => updater(current))}
        showHostCardToggle={true}
        compact={compact}
      />
    </StorySurface>
  );
}

function ToggleListInlineToolbarStory() {
  const [settings, setSettings] = useState<ToggleListSettings>(() =>
    getDefaultToggleListSettings(),
  );
  const [sourceProjectId, setSourceProjectId] = useState("default");
  const [rulesPanelExpanded, setRulesPanelExpanded] = useState(true);

  return (
    <StorySurface>
      <section className="relative box-border w-full max-w-full rounded-lg bg-transparent p-0">
        <div className="inline-flex items-center gap-1 rounded-lg px-0.5 py-0.5">
          <button
            type="button"
            className={cn(PROJECTION_ACTION_BTN, "w-7 cursor-grab justify-center px-0")}
          >
            ⋮⋮
          </button>
          <NodexOptionPicker
            value={sourceProjectId}
            onValueChange={setSourceProjectId}
            options={PROJECT_OPTIONS}
            search="filter"
            searchPlaceholder="Search projects…"
            searchAriaLabel="Search projects"
            triggerButton={
              <NodexDropdownButtonTrigger className={cn(PROJECTION_ACTION_BTN, "h-7! pr-2")}>
                <span className="inline-flex items-center gap-1.5">
                  <Layers3 className="size-3.5" />
                  {sourceProjectId}
                </span>
              </NodexDropdownButtonTrigger>
            }
          />
          <button
            type="button"
            className={cn(
              PROJECTION_ACTION_BTN,
              rulesPanelExpanded &&
                "border-[color-mix(in_srgb,var(--accent-blue)_55%,var(--border))] bg-[color-mix(in_srgb,var(--accent-blue)_8%,var(--card))] text-(--foreground)",
            )}
            onClick={() => setRulesPanelExpanded((current) => !current)}
          >
            <SlidersHorizontal className="size-3.5" />
            Rules
          </button>
        </div>

        {rulesPanelExpanded ? (
          <div className="mt-2 flex flex-col gap-2 rounded-lg border border-(--border) bg-(--card) p-2.5">
            <div className="flex items-center justify-between gap-2">
              <ToggleListSummaryBadges settings={settings} visibleCount={12} />
              <button
                type="button"
                className={cn(PROJECTION_ACTION_BTN, "h-6 px-2")}
                onClick={() => setSettings(getDefaultToggleListSettings())}
              >
                <ResetIcon className="size-3" />
                Reset
              </button>
            </div>
            <ToggleListRulesBody
              settings={settings}
              availableTags={AVAILABLE_TAGS}
              updateSettings={(updater) => setSettings((current) => updater(current))}
              showHostCardToggle={true}
              compact={true}
            />
          </div>
        ) : null}
      </section>
    </StorySurface>
  );
}

const meta = {
  title: "Board/Toggle List Controls",
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const RulesBody: Story = {
  render: () => <ToggleListRulesStory />,
};

export const RulesBodyCompact: Story = {
  render: () => <ToggleListRulesStory compact={true} />,
};

export const InlineViewToolbar: Story = {
  render: () => <ToggleListInlineToolbarStory />,
};
