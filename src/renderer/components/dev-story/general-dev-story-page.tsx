import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { PermissionModeDropdown } from "@/components/workbench/stage-threads/stage-threads-permission-mode-dropdown";
import { ToolbarDropdownMenu } from "@/components/workbench/stage-threads/stage-threads-toolbar-dropdown-menu";
import {
  cardStagePropertyEmptyValueInteractive,
  cardStagePropertyTextSize,
  cardStagePropertyValueHoverSurface,
} from "@/components/kanban/card-stage/property-value-styles";
import { cn } from "@/lib/utils";
import type { CodexPermissionMode } from "@/lib/types";
import {
  ArrowUpRight,
  Bell,
  Filter,
  Layers3,
  LayoutGrid,
  PanelTopOpen,
  Search,
  Sparkles,
  WandSparkles,
} from "lucide-react";

type StorySectionId = "primitives" | "feedback" | "patterns";
export type GeneralDevStoryDensity = "compact" | "balanced" | "comfortable";
export const GENERAL_DEV_STORY_DENSITY_OPTIONS = ["compact", "balanced", "comfortable"] as const;

const STORY_SECTIONS: Array<{
  id: StorySectionId;
  label: string;
  description: string;
}> = [
    {
      id: "primitives",
      label: "Primitives",
      description: "Core inputs, actions, and selection controls.",
    },
    {
      id: "feedback",
      label: "Feedback",
      description: "Overlays, scrollers, and transient guidance.",
    },
    {
      id: "patterns",
      label: "App Patterns",
      description: "House interaction shapes reused across the renderer.",
    },
  ];

const BRANCH_ITEMS = [
  { value: "main", label: "main", description: "Stable default branch" },
  { value: "codex/ui-story-page", label: "codex/ui-story-page", description: "Current feature branch" },
  { value: "release/0.6", label: "release/0.6", description: "Pre-release stabilization" },
];

const SELECT_DENSITY_OPTIONS: Array<{ value: GeneralDevStoryDensity; label: string }> = [
  { value: "compact", label: "Compact" },
  { value: "balanced", label: "Balanced" },
  { value: "comfortable", label: "Comfortable" },
];

const SCROLL_ITEMS = [
  "Review branch selector spacing against toolbar chips.",
  "Confirm tooltip density in the card stage toolbar.",
  "Audit hover opacity for sidebar and stage tabs.",
  "Validate dropdown blur/ring treatment on light and dark themes.",
  "Compare input heights across settings and composer surfaces.",
  "Keep dev stories production-backed instead of fake token mocks.",
];

function StorySection({
  id,
  title,
  description,
  children,
}: {
  id: StorySectionId;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6 space-y-3">
      <div className="space-y-1">
        <div className="text-xs font-semibold tracking-wide text-(--foreground-tertiary) uppercase">
          {title}
        </div>
        <div className="max-w-3xl text-sm/relaxed text-(--foreground-secondary)">
          {description}
        </div>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">{children}</div>
    </section>
  );
}

function ShowcaseCard({
  title,
  description,
  source,
  children,
  className,
}: {
  title: string;
  description: string;
  source: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <article
      className={cn(
        "flex min-h-58 flex-col rounded-[20px] border-[0.5px] border-[color-mix(in_srgb,var(--border)_82%,transparent)] bg-[color-mix(in_srgb,var(--background-secondary)_72%,transparent)] shadow-[0_16px_40px_rgba(0,0,0,0.16)]",
        className,
      )}
    >
      <div className="space-y-1 border-b border-[color-mix(in_srgb,var(--border)_72%,transparent)] px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-(--foreground)">{title}</div>
            <div className="mt-1 text-sm/relaxed text-(--foreground-secondary)">
              {description}
            </div>
          </div>
          <Badge variant="outline" className="border-transparent bg-foreground-5 text-(--foreground-secondary)">
            Live
          </Badge>
        </div>
        <code className="text-xs text-(--foreground-tertiary)">{source}</code>
      </div>
      <div className="flex min-h-0 flex-1 p-4">{children}</div>
    </article>
  );
}

function PreviewSurface({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 rounded-2xl border-[0.5px] border-[color-mix(in_srgb,var(--border)_70%,transparent)] bg-[color-mix(in_srgb,var(--background)_94%,transparent)] p-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

function PatternRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-5 p-3">
      <div className="min-w-0">
        <div className="text-sm text-(--foreground)">{label}</div>
        <div className="mt-1 text-sm/relaxed text-(--foreground-secondary)">
          {description}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function DialogPreview() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="flex flex-col items-start gap-3">
        <DialogTrigger asChild>
          <Button variant="default">
            <WandSparkles className="size-4" />
            Open Confirm Dialog
          </Button>
        </DialogTrigger>
        <div className="text-sm/relaxed text-(--foreground-secondary)">
          Uses the shared dialog chrome so confirmation flows stay visually consistent.
        </div>
      </div>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Apply spacing preset?</DialogTitle>
          <DialogDescription>
            This would update the current Storybook gallery density controls to the balanced preset.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => setOpen(false)}>Apply preset</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface GeneralDevStoryPageProps {
  density?: GeneralDevStoryDensity;
  permissionMode?: CodexPermissionMode;
}

export function GeneralDevStoryPage({
  density: initialDensity = "balanced",
  permissionMode: initialPermissionMode = "sandbox",
}: GeneralDevStoryPageProps) {
  const [density, setDensity] = useState<GeneralDevStoryDensity>(initialDensity);
  const [permissionMode, setPermissionMode] = useState<CodexPermissionMode>(initialPermissionMode);

  useEffect(() => {
    setDensity(initialDensity);
  }, [initialDensity]);

  useEffect(() => {
    setPermissionMode(initialPermissionMode);
  }, [initialPermissionMode]);

  const densityLabel = useMemo(() => {
    return SELECT_DENSITY_OPTIONS.find((option) => option.value === density)?.label ?? "Balanced";
  }, [density]);

  return (
    <div className="min-h-[calc(100vh-3rem)] bg-(--background) text-(--foreground)">
      <div className="mx-auto flex w-full max-w-[1380px] flex-col gap-8">
        <section className="rounded-[24px] border-[0.5px] border-[color-mix(in_srgb,var(--border)_75%,transparent)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--background-secondary)_88%,transparent),color-mix(in_srgb,var(--background)_98%,transparent))] p-5 shadow-[0_24px_64px_rgba(0,0,0,0.18)]">
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-3xl">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-foreground text-(--background)">Renderer Source of Truth</Badge>
                  <Badge variant="outline" className="border-transparent bg-foreground-5 text-(--foreground-secondary)">
                    11 shared patterns
                  </Badge>
                </div>
                <h1 className="mt-3 text-2xl font-medium tracking-tight text-(--foreground)">
                  Common UI components
                </h1>
                <div className="mt-3 text-base/relaxed text-(--foreground-secondary)">
                  This page is for refinement, not marketing. It keeps shared building blocks visible together so spacing, state contrast, and overlay behavior can be compared without threading through live project data.
                </div>
              </div>

              <div className="flex max-w-sm min-w-72 flex-col gap-2 rounded-[20px] border-[0.5px] border-[color-mix(in_srgb,var(--border)_70%,transparent)] bg-[color-mix(in_srgb,var(--background)_94%,transparent)] p-3">
                <div className="flex items-center gap-2 text-sm text-(--foreground)">
                  <Sparkles className="size-4 text-(--foreground-secondary)" />
                  Current sample state
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="border-transparent bg-foreground-5 text-(--foreground-secondary)">
                    Density: {densityLabel}
                  </Badge>
                  <Badge variant="outline" className="border-transparent bg-foreground-5 text-(--foreground-secondary)">
                    Permission: {permissionMode}
                  </Badge>
                  <Badge variant="outline" className="border-transparent bg-foreground-5 text-(--foreground-secondary)">
                    Storybook globals live
                  </Badge>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {STORY_SECTIONS.map((section) => (
                <a
                  key={section.id}
                  href={`#${section.id}`}
                  className="rounded-full border-[0.5px] border-[color-mix(in_srgb,var(--border)_75%,transparent)] bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)] px-3 py-1.5 text-sm text-(--foreground-secondary) transition-colors duration-100 hover:bg-foreground-5 hover:text-(--foreground)"
                >
                  {section.label}
                </a>
              ))}
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              <div className="rounded-[18px] border-[0.5px] border-[color-mix(in_srgb,var(--border)_75%,transparent)] bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)] px-3 py-3 text-sm/relaxed text-(--foreground-secondary)">
                Storybook owns the global environment for this gallery. Theme and typography live in the toolbar, while scene-level state belongs in story args.
              </div>
              <div className="rounded-[18px] border-[0.5px] border-[color-mix(in_srgb,var(--border)_75%,transparent)] bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)] px-3 py-3 text-sm/relaxed text-(--foreground-secondary)">
                Use real production components as the source of truth instead of parallel demo-only lookalikes.
              </div>
              <div className="rounded-[18px] border-[0.5px] border-[color-mix(in_srgb,var(--border)_75%,transparent)] bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)] px-3 py-3 text-sm/relaxed text-(--foreground-secondary)">
                Keep selector poppers on one shared chrome system while letting triggers stay local to their surface.
              </div>
            </div>
          </div>
        </section>

        <div className="flex w-full flex-col gap-8">
          <StorySection
            id="primitives"
            title="Primitives"
            description="These are the shared controls from `components/ui`. The goal is to inspect size rhythm, state contrast, and token alignment while using the exact production exports."
          >
            <ShowcaseCard
              title="Buttons + badges"
              description="Primary action, ghost action, icon button, and status badges shown side by side."
              source="src/renderer/components/ui/button.tsx + badge.tsx"
            >
              <PreviewSurface className="flex flex-col justify-between gap-4">
                <div className="flex flex-wrap gap-2">
                  <Button>
                    <Sparkles className="size-4" />
                    Primary action
                  </Button>
                  <Button variant="outline">Outline</Button>
                  <Button variant="ghost">Ghost</Button>
                  <Button size="icon-sm" variant="outline" aria-label="Open detail">
                    <ArrowUpRight className="size-4" />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge>Ready</Badge>
                  <Badge variant="secondary">Draft</Badge>
                  <Badge variant="outline">Needs review</Badge>
                  <Badge variant="destructive">Blocked</Badge>
                </div>
              </PreviewSurface>
            </ShowcaseCard>

            <ShowcaseCard
              title="Inputs + textarea"
              description="Base field treatments used in settings, composer, and inline editors."
              source="src/renderer/components/ui/input.tsx + textarea.tsx"
            >
              <PreviewSurface className="flex flex-col gap-3">
                <Input placeholder="Search cards, files, or commands" defaultValue="stage-threads" />
                <Input disabled value="Disabled field state" readOnly />
                <Textarea
                  defaultValue={"A compact multiline surface for prompts, notes, or descriptions.\nIt should remain quiet until focus and selection states need to show."}
                />
              </PreviewSurface>
            </ShowcaseCard>

            <ShowcaseCard
              title="Select"
              description="Radix-backed select behavior with the shared frosted selector menu chrome used across toolbar, dialog, and card-stage poppers."
              source="src/renderer/components/ui/select.tsx"
            >
              <PreviewSurface className="items-start">
                <div className="w-full max-w-sm space-y-3">
                  <Select value={density} onValueChange={(value) => setDensity(value as GeneralDevStoryDensity)}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose density" />
                    </SelectTrigger>
                    <SelectContent>
                      {SELECT_DENSITY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="text-sm/relaxed text-(--foreground-secondary)">
                    Current value: <span className="text-(--foreground)">{densityLabel}</span>
                  </div>
                </div>
              </PreviewSurface>
            </ShowcaseCard>

            <ShowcaseCard
              title="Dialog"
              description="Shared confirmation shell with the standard header/footer rhythm."
              source="src/renderer/components/ui/dialog.tsx"
            >
              <PreviewSurface className="items-start">
                <DialogPreview />
              </PreviewSurface>
            </ShowcaseCard>
          </StorySection>

          <StorySection
            id="feedback"
            title="Feedback"
            description="Feedback primitives matter because most of the app’s precision comes from hover, overlay, and scroll behavior rather than heavy container chrome."
          >
            <ShowcaseCard
              title="Tooltip"
              description="The shared tooltip uses a frosted surface and short, dense copy."
              source="src/renderer/components/ui/tooltip.tsx"
            >
              <PreviewSurface className="items-center justify-between gap-4">
                <div className="max-w-sm text-sm/relaxed text-(--foreground-secondary)">
                  Hover the action to inspect the default tooltip treatment used throughout the workbench.
                </div>
                <Tooltip content="Keeps controls quiet until intent is clear." side="top">
                  <Button variant="outline">
                    <Bell className="size-4" />
                    Hover for tooltip
                  </Button>
                </Tooltip>
              </PreviewSurface>
            </ShowcaseCard>

            <ShowcaseCard
              title="Scroll area"
              description="Viewport and thumb styling for compact inspector-like content."
              source="src/renderer/components/ui/scroll-area.tsx"
            >
              <PreviewSurface className="min-h-0">
                <ScrollArea className="h-52 w-full rounded-2xl bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)] p-1">
                  <div className="space-y-1 p-2">
                    {SCROLL_ITEMS.map((item, index) => (
                      <div
                        key={item}
                        className="flex items-start gap-3 rounded-xl px-3 py-2 transition-colors duration-100 hover:bg-foreground-5"
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground-5 text-xs text-(--foreground-secondary)">
                          {index + 1}
                        </span>
                        <span className="text-sm/relaxed text-(--foreground-secondary)">{item}</span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </PreviewSurface>
            </ShowcaseCard>
          </StorySection>

          <StorySection
            id="patterns"
            title="App Patterns"
            description="These are not generic library primitives. They are the recurring Nodex shapes built on top of the primitives: pill toolbar menus, dense settings rows, and metadata chips."
          >
            <ShowcaseCard
              title="Toolbar menus"
              description="Compact pill triggers used in thread and toolbar surfaces for branch, mode, and selector controls."
              source="src/renderer/components/workbench/stage-threads/stage-threads-toolbar-dropdown-menu.tsx + stage-threads-permission-mode-dropdown.tsx"
            >
              <PreviewSurface className="flex flex-col justify-between gap-4">
                <div className="flex flex-wrap gap-2">
                  <ToolbarDropdownMenu
                    label="codex/ui-story-page"
                    title="Branch"
                    ariaLabel="Branch selector"
                    items={BRANCH_ITEMS}
                    selectedValue="codex/ui-story-page"
                    onSelect={() => undefined}
                    showDescriptions
                  />
                  <PermissionModeDropdown
                    selectedMode={permissionMode}
                    customDescription="Reads the effective permission mode from config.toml when selected."
                    onSelect={setPermissionMode}
                  />
                </div>
                <div className="text-sm/relaxed text-(--foreground-secondary)">
                  These controls favor low chrome, strong hover states, and floating frosted menus instead of permanent boxed filters.
                </div>
              </PreviewSurface>
            </ShowcaseCard>

            <ShowcaseCard
              title="Dense settings rows"
              description="Flat rows with internal dividers, matching the current settings overlay layout."
              source="src/renderer/components/workbench/workbench-settings-overlay.tsx"
            >
              <PreviewSurface className="p-0">
                <div className="flex w-full flex-col divide-y divide-[color-mix(in_srgb,var(--border)_70%,transparent)] rounded-2xl border-[0.5px] border-[color-mix(in_srgb,var(--border)_75%,transparent)] bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)]">
                  <PatternRow
                    label="Stage density"
                    description="How tightly stage content and supporting chrome are packed."
                  >
                    <Badge variant="outline" className="border-transparent bg-foreground-5 text-(--foreground-secondary)">
                      {densityLabel}
                    </Badge>
                  </PatternRow>
                  <PatternRow
                    label="Focus hints"
                    description="Use opacity shifts and subtle tinting instead of heavy separators."
                  >
                    <Button variant="ghost" size="sm">
                      <LayoutGrid className="size-4" />
                      Tune
                    </Button>
                  </PatternRow>
                  <PatternRow
                    label="Toolbar reveal"
                    description="Secondary actions stay visually quiet until hover or active state."
                  >
                    <Button variant="outline" size="sm">
                      <PanelTopOpen className="size-4" />
                      Inspect
                    </Button>
                  </PatternRow>
                </div>
              </PreviewSurface>
            </ShowcaseCard>

            <ShowcaseCard
              title="Property chips"
              description="Card-stage metadata style for filled values and empty interactive placeholders."
              source="src/renderer/components/kanban/card-stage/property-value-styles.ts"
            >
              <PreviewSurface className="flex flex-col justify-between gap-4">
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={cn("inline-flex items-center gap-2 px-2 py-1", cardStagePropertyValueHoverSurface)}>
                    <span className={cardStagePropertyTextSize}>In progress</span>
                    <Badge variant="outline" className="border-transparent bg-foreground-5 text-(--foreground-secondary)">P1</Badge>
                  </button>
                  <button type="button" className={cn("inline-flex items-center gap-2 px-2 py-1", cardStagePropertyValueHoverSurface)}>
                    <span className={cardStagePropertyTextSize}>ui</span>
                    <span className={cardStagePropertyTextSize}>threads</span>
                  </button>
                  <button type="button" className={cn("inline-flex items-center gap-2 px-2 py-1", cardStagePropertyEmptyValueInteractive)}>
                    <span>Add estimate</span>
                  </button>
                </div>
                <div className="text-sm/relaxed text-(--foreground-secondary)">
                  The shared card-stage value styles keep metadata readable without turning every property into a boxed input.
                </div>
              </PreviewSurface>
            </ShowcaseCard>

            <ShowcaseCard
              title="Command/search strip"
              description="A representative dense strip built from the same base primitives used in search and quick-action surfaces."
              source="production composition"
            >
              <PreviewSurface className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2 rounded-2xl border-[0.5px] border-[color-mix(in_srgb,var(--border)_72%,transparent)] bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)] p-2">
                  <Button variant="ghost" size="icon-sm" aria-label="Search">
                    <Search className="size-4" />
                  </Button>
                  <Input className="max-w-sm border-none bg-transparent shadow-none focus-visible:ring-0" placeholder="Search stories, controls, or tokens" />
                  <div className="ml-auto flex items-center gap-2">
                    <Badge variant="outline" className="border-transparent bg-foreground-5 text-(--foreground-secondary)">
                      <Filter className="mr-1 size-3" />
                      Filters
                    </Badge>
                    <Button size="sm">
                      <Layers3 className="size-4" />
                      Open palette
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="border-transparent bg-foreground-5 text-(--foreground-secondary)">
                    Search shell
                  </Badge>
                  <Badge variant="outline" className="border-transparent bg-foreground-5 text-(--foreground-secondary)">
                    Toolbar affordances
                  </Badge>
                  <Badge variant="outline" className="border-transparent bg-foreground-5 text-(--foreground-secondary)">
                    Input quiet state
                  </Badge>
                </div>
              </PreviewSurface>
            </ShowcaseCard>
          </StorySection>
        </div>
      </div>
    </div>
  );
}
