import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { Shield, Sparkles } from "@/components/shared/icons/generic-icons";
import {
  ArchiveIcon,
  DatabaseIcon,
  MoveToIcon,
  OpenInIcon,
  PageIcon,
  ProjectAccessIcon,
  ProjectRemovedIcon,
  SidePanelBrowserIcon,
  SidePanelFilesIcon,
  SidePanelReviewIcon,
  SidePanelSideChatIcon,
  ConfigStatusIcon,
  EstimateIcon,
  CheckmarkIcon,
  SettingsGeneralIcon,
  SettingsGitIcon,
  RefreshIcon,
  BoardIcon,
} from "@/components/shared/icons";
import { StatusIcon, StatusLabel } from "@/lib/status-presentation";
import { WORKFLOW_STATUS_LABELS, WORKFLOW_STATUS_ORDER } from "../../../shared/workflow-status";
import { NodexButton } from "./button";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "./dialog";
import {
  NodexDropdownButtonTrigger,
  NodexOptionPicker,
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
  NodexDropdownTitle,
} from "./dropdown";
import {
  NodexPopover,
  NodexPopoverContent,
  NodexPopoverTitle,
  NodexPopoverTrigger,
} from "./popover";
import { NodexSettingsPageSurface, NodexSettingsRow, NodexSettingsSection } from "./settings";
import { NodexToastProvider, toast } from "./toast";
import { NodexTooltip, NodexTooltipProvider } from "./tooltip";
import { ShortcutKeycaps } from "./shortcut-keycaps";

function StorySurface({ children }: { children: React.ReactNode }) {
  return (
    <NodexTooltipProvider>
      <div className="flex min-h-screen items-start justify-center bg-token-main-surface-primary p-10">
        {children}
      </div>
    </NodexTooltipProvider>
  );
}

function ShortcutKeycapsDemo() {
  return (
    <StorySurface>
      <div className="flex max-w-xl flex-col gap-5 rounded-xl bg-token-main-surface-secondary p-5 text-token-foreground ring-[0.5px] ring-token-border">
        <div className="flex items-center gap-2">
          <ShortcutKeycaps keys={["C"]} density="compact" />
          <ShortcutKeycaps keys={["⌘⇧C"]} />
          <ShortcutKeycaps keys={["Ctrl+Shift+C"]} />
          <ShortcutKeycaps keys={["Shift + Tab"]} density="settings" />
        </div>
        <div className="flex items-center gap-3 rounded-lg bg-token-foreground px-3 py-2 text-token-main-surface-primary">
          <span className="text-sm">Current-color surface</span>
          <ShortcutKeycaps keys={["C"]} tone="current" />
        </div>
        <NodexTooltip defaultOpen tooltipContent="Create Page" shortcutLabel="C">
          <NodexButton size="xs">Tooltip keycap</NodexButton>
        </NodexTooltip>
      </div>
    </StorySurface>
  );
}

function WorkflowStatusIconDemo() {
  return (
    <StorySurface>
      <div className="grid grid-cols-[6rem_4rem_4rem_auto] items-center gap-x-5 gap-y-3 rounded-xl bg-token-main-surface-secondary p-5 text-token-foreground ring-[0.5px] ring-token-border">
        <span className="text-xs font-medium text-token-description-foreground">Status</span>
        <span className="text-xs font-medium text-token-description-foreground">14px</span>
        <span className="text-xs font-medium text-token-description-foreground">16px</span>
        <span className="text-xs font-medium text-token-description-foreground">Label</span>
        {WORKFLOW_STATUS_ORDER.map((status) => (
          <div key={status} className="contents">
            <span className="text-sm">{WORKFLOW_STATUS_LABELS[status]}</span>
            <StatusIcon statusId={status} />
            <StatusIcon statusId={status} className="size-4" />
            <StatusLabel statusId={status} />
          </div>
        ))}
      </div>
    </StorySurface>
  );
}

function XsTriggerDropdownDemo() {
  const [value, setValue] = useState("auto");

  return (
    <StorySurface>
      <NodexOptionPicker
        open={true}
        value={value}
        onValueChange={setValue}
        contentWidth="xs"
        triggerButton={
          <NodexDropdownButtonTrigger size="xs" className="min-w-18">
            {value === "auto" ? "Auto" : value === "high" ? "High" : "Low"}
          </NodexDropdownButtonTrigger>
        }
        options={[
          { value: "auto", label: "Auto" },
          { value: "high", label: "High" },
          { value: "low", label: "Low" },
        ]}
      />
    </StorySurface>
  );
}

function CompactIconLabelTriggerDemo() {
  const [value, setValue] = useState("estimate");

  return (
    <StorySurface>
      <NodexOptionPicker
        open={true}
        value={value}
        onValueChange={setValue}
        contentWidth="xs"
        triggerButton={
          <NodexDropdownButtonTrigger size="xs">
            <EstimateIcon className="size-4" />
            <span>Estimate</span>
          </NodexDropdownButtonTrigger>
        }
        options={[
          { value: "estimate", label: "Estimate" },
          { value: "priority", label: "Priority" },
        ]}
      />
    </StorySurface>
  );
}

function IconOnlyDropdownDemo() {
  const [value, setValue] = useState("run");

  return (
    <StorySurface>
      <NodexDropdownMenu
        open={true}
        contentWidth="icon"
        triggerButton={
          <NodexDropdownButtonTrigger
            aria-label="Action icon"
            showChevron={false}
            className="size-8 justify-center rounded-full px-0"
          >
            <Sparkles className="size-4" />
          </NodexDropdownButtonTrigger>
        }
      >
        <NodexDropdownTitle>Action icon</NodexDropdownTitle>
        <NodexDropdownItem
          leftSlot={<Sparkles className="size-4" />}
          rightSlot={value === "run" ? <CheckmarkIcon className="size-4" /> : null}
          onSelect={() => setValue("run")}
        >
          Run
        </NodexDropdownItem>
        <NodexDropdownItem
          leftSlot={<Shield className="size-4" />}
          rightSlot={value === "sandbox" ? <CheckmarkIcon className="size-4" /> : null}
          onSelect={() => setValue("sandbox")}
        >
          Sandbox
        </NodexDropdownItem>
      </NodexDropdownMenu>
    </StorySurface>
  );
}

function PanelActionIconDropdownDemo() {
  return (
    <StorySurface>
      <NodexDropdownMenu
        open={true}
        contentWidth="menuWide"
        triggerButton={
          <NodexDropdownButtonTrigger className="min-w-32">Panel tab</NodexDropdownButtonTrigger>
        }
      >
        <NodexDropdownItem
          leftSlot={<SidePanelFilesIcon className="icon-sm" />}
          keyboardShortcut="⌘P"
        >
          Files
        </NodexDropdownItem>
        <NodexDropdownItem leftSlot={<SidePanelSideChatIcon className="icon-sm" />}>
          Side chat
        </NodexDropdownItem>
        <NodexDropdownItem
          leftSlot={<SidePanelBrowserIcon className="icon-sm" />}
          keyboardShortcut="⌘T"
        >
          Browser
        </NodexDropdownItem>
        <NodexDropdownItem
          leftSlot={<SidePanelReviewIcon className="icon-sm" />}
          keyboardShortcut="⌃⇧G"
        >
          Review
        </NodexDropdownItem>
        <NodexDropdownItem leftSlot={<DatabaseIcon className="icon-sm" />}>
          DB View
        </NodexDropdownItem>
        <NodexDropdownItem leftSlot={<BoardIcon className="icon-sm" />}>
          Page Stage
        </NodexDropdownItem>
      </NodexDropdownMenu>
    </StorySurface>
  );
}

function LibraryActionIconDropdownDemo() {
  return (
    <StorySurface>
      <NodexDropdownMenu
        open={true}
        triggerButton={
          <NodexDropdownButtonTrigger className="min-w-32">Library item</NodexDropdownButtonTrigger>
        }
      >
        <NodexDropdownItem leftSlot={<PageIcon />}>Page</NodexDropdownItem>
        <NodexDropdownItem leftSlot={<DatabaseIcon />}>Database</NodexDropdownItem>
        <NodexDropdownSeparator />
        <NodexDropdownItem leftSlot={<MoveToIcon />}>Move to</NodexDropdownItem>
        <NodexDropdownItem leftSlot={<ProjectAccessIcon />}>Manage access</NodexDropdownItem>
        <NodexDropdownItem leftSlot={<OpenInIcon />}>Open in Project…</NodexDropdownItem>
        <NodexDropdownItem leftSlot={<ArchiveIcon />}>Archive</NodexDropdownItem>
        <NodexDropdownItem leftSlot={<RefreshIcon />}>Restore</NodexDropdownItem>
        <NodexDropdownSeparator />
        <NodexDropdownItem leftSlot={<ProjectRemovedIcon />}>Removed projects…</NodexDropdownItem>
      </NodexDropdownMenu>
    </StorySurface>
  );
}

function LongLabelDropdownDemo() {
  return (
    <StorySurface>
      <NodexOptionPicker
        open={true}
        value="workspace"
        onValueChange={() => {}}
        contentWidth="workspace"
        triggerButton={
          <NodexDropdownButtonTrigger className="w-[22rem] justify-start">
            A very long workspace label that should truncate cleanly without breaking the trigger
            chrome
          </NodexDropdownButtonTrigger>
        }
        options={[
          {
            value: "workspace",
            label:
              "A very long workspace label that should truncate cleanly without breaking the menu",
            tooltipText: "/Users/asc/repo/nodex/design.local/codex-electron-app",
          },
          {
            value: "beta",
            label: "Beta workspace with another long descriptive suffix",
          },
        ]}
      />
    </StorySurface>
  );
}

function SearchableDropdownDemo() {
  const [value, setValue] = useState("nodex");

  return (
    <StorySurface>
      <NodexOptionPicker
        open={true}
        value={value}
        onValueChange={setValue}
        search="filter"
        searchPlaceholder="Search projects…"
        searchAriaLabel="Search projects"
        title="Project"
        contentWidth="panel"
        triggerButton={
          <NodexDropdownButtonTrigger className="min-w-40">
            Searchable menu
          </NodexDropdownButtonTrigger>
        }
        options={[
          {
            value: "nodex",
            label: "Nodex",
            leftSlot: <SettingsGitIcon className="size-4" />,
          },
          {
            value: "bundle",
            label: "Codex Electron readable bundle",
            leftSlot: <SettingsGitIcon className="size-4" />,
          },
        ]}
      />
    </StorySurface>
  );
}

function FlyoutSubmenuDropdownDemo() {
  const [value, setValue] = useState("10");

  return (
    <StorySurface>
      <NodexDropdownMenu
        open={true}
        contentWidth="sm"
        triggerButton={
          <NodexDropdownButtonTrigger showChevron={false} className="size-8 justify-center px-0">
            <SettingsGeneralIcon className="size-4" />
          </NodexDropdownButtonTrigger>
        }
      >
        <NodexDropdownFlyoutSubmenuItem
          label="Show"
          contentClassName="min-w-[180px]"
          triggerContent={
            <div className="flex w-full items-center gap-2 text-sm">
              <ConfigStatusIcon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Show</span>
              <span className="ml-auto shrink-0 text-xs text-token-description-foreground">10</span>
            </div>
          }
        >
          {["10", "25", "50"].map((limit) => (
            <NodexDropdownItem
              key={limit}
              onSelect={() => setValue(limit)}
              rightSlot={value === limit ? <CheckmarkIcon className="size-4" /> : null}
            >
              {limit} items
            </NodexDropdownItem>
          ))}
        </NodexDropdownFlyoutSubmenuItem>
        <NodexDropdownItem leftSlot={<SettingsGitIcon className="size-4" />}>
          Move down
        </NodexDropdownItem>
      </NodexDropdownMenu>
    </StorySurface>
  );
}

function CompactTooltipDemo() {
  return (
    <StorySurface>
      <div className="flex items-center gap-4">
        <NodexTooltip open={true} tooltipContent="Edit">
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-full bg-token-main-surface-secondary text-token-description-foreground ring-1 ring-token-border"
          >
            <SettingsGeneralIcon className="size-4" />
          </button>
        </NodexTooltip>
        <NodexTooltip
          open={true}
          tooltipContent="/Users/asc/repo/nodex/README.md"
          side="bottom"
          align="start"
        >
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-full bg-token-main-surface-secondary px-3 text-sm text-token-foreground ring-1 ring-token-border"
          >
            README.md
          </button>
        </NodexTooltip>
      </div>
    </StorySurface>
  );
}

function PopoverDemo() {
  return (
    <StorySurface>
      <NodexPopover open={true}>
        <NodexPopoverTrigger>
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-full bg-token-main-surface-secondary px-3 text-sm text-token-foreground ring-1 ring-token-border"
          >
            Project manager
          </button>
        </NodexPopoverTrigger>
        <NodexPopoverContent className="w-72 gap-1 p-2">
          <NodexPopoverTitle className="px-2 py-1 text-sm font-medium">Projects</NodexPopoverTitle>
          <div className="flex flex-col gap-1 px-1 pb-1">
            <button
              type="button"
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-token-list-hover-background"
            >
              <span className="size-2.5 rounded-full bg-[var(--accent-blue)]" />
              Nodex
            </button>
            <button
              type="button"
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-token-list-hover-background"
            >
              <span className="size-2.5 rounded-full bg-[var(--accent-green)]" />
              Codex readable bundle
            </button>
          </div>
        </NodexPopoverContent>
      </NodexPopover>
    </StorySurface>
  );
}

function DialogDemo({ danger = false }: { danger?: boolean }) {
  return (
    <StorySurface>
      <NodexDialog open={true}>
        <NodexDialogContent size="compact">
          <NodexDialogFrame>
            <NodexDialogHeader>
              <NodexDialogTitle>
                {danger ? "Remove project?" : "Save project changes?"}
              </NodexDialogTitle>
              <NodexDialogDescription>
                {danger
                  ? "The project will be removed from Nodex. Files on disk will not be deleted."
                  : "Review the project details before saving your changes."}
              </NodexDialogDescription>
            </NodexDialogHeader>
            <NodexDialogBody>
              <div className="rounded-lg bg-token-foreground/5 px-3 py-2 text-base text-token-text-secondary">
                /Users/asc/repo/nodex2
              </div>
            </NodexDialogBody>
            <NodexDialogFooter>
              <NodexDialogAction>Cancel</NodexDialogAction>
              <NodexDialogAction tone={danger ? "danger" : "primary"}>
                {danger ? "Remove project" : "Review project"}
              </NodexDialogAction>
            </NodexDialogFooter>
          </NodexDialogFrame>
        </NodexDialogContent>
      </NodexDialog>
    </StorySurface>
  );
}

function SettingsDemo() {
  return (
    <StorySurface>
      <div className="h-[720px] w-full max-w-4xl overflow-hidden rounded-[24px] border border-token-border bg-token-side-bar-background">
        <NodexSettingsPageSurface
          title="Environments"
          subtitle="Local environments tell Nodex how to set up worktrees for a project."
          action={<NodexButton size="composer">Add project</NodexButton>}
        >
          <NodexSettingsSection title="Select a project">
            <NodexSettingsRow label="Nodex" description="/Users/asc/repo/nodex">
              <NodexButton variant="secondary" size="sm">
                Open
              </NodexButton>
            </NodexSettingsRow>
            <NodexSettingsRow
              label="Codex Electron bundle"
              description="/Users/asc/repo/devtools-codex"
            >
              <NodexButton variant="ghost" size="sm">
                View
              </NodexButton>
            </NodexSettingsRow>
          </NodexSettingsSection>
        </NodexSettingsPageSurface>
      </div>
    </StorySurface>
  );
}

function ToastDemo() {
  useEffect(() => {
    toast.closeAll();
    toast.info("Workspace indexed", {
      description: "Nodex finished scanning 148 files.",
      duration: 0,
    });
    toast.info("Page draft closed", {
      action: {
        label: "Restore",
        onClick: () => false,
      },
      duration: 0,
    });
    toast.success("Managed worktree ready", {
      description: "Environment setup completed successfully.",
      duration: 0,
    });
    toast.warning("Review snapshot is stale", {
      description: "Refresh review state before applying more hunks.",
      duration: 0,
    });
    toast.danger("Could not start the helper thread", {
      description: "The selected environment script exited with code 1.",
      duration: 0,
    });
    toast.info("Syncing OAuth callback", {
      id: "oauth-flow",
      duration: 0,
    });
    toast.success("Connected to GitHub", {
      id: "oauth-flow",
      description: "The keyed toast replaced the earlier pending state.",
      duration: 0,
    });
    toast.custom({
      level: "danger",
      duration: 0,
      hasCloseButton: false,
      renderContent: ({ close }) => (
        <div className="flex items-start gap-3 p-3">
          <div className="mt-0.5 size-2.5 rounded-full bg-token-charts-red" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-token-foreground">Git push failed</div>
            <div className="text-sm text-token-description-foreground">
              Non-fast-forward update rejected. Review the remote branch before retrying.
            </div>
          </div>
          <NodexButton variant="secondary" size="xs" onClick={close}>
            Dismiss
          </NodexButton>
        </div>
      ),
    });

    return () => {
      toast.closeAll();
    };
  }, []);

  return (
    <NodexToastProvider>
      <StorySurface>
        <div className="text-sm text-token-description-foreground">Global toast stack preview</div>
      </StorySurface>
    </NodexToastProvider>
  );
}

const meta = {
  title: "Workbench/Shared/UI",
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const DropdownXsTrigger: Story = {
  render: () => <XsTriggerDropdownDemo />,
};

export const DropdownCompactIconLabelTrigger: Story = {
  render: () => <CompactIconLabelTriggerDemo />,
};

export const DropdownIconOnlyTrigger: Story = {
  render: () => <IconOnlyDropdownDemo />,
};

export const DropdownPanelActionIcons: Story = {
  render: () => <PanelActionIconDropdownDemo />,
};

export const DropdownLibraryActionIcons: Story = {
  render: () => <LibraryActionIconDropdownDemo />,
};

export const DropdownLongLabelTrigger: Story = {
  render: () => <LongLabelDropdownDemo />,
};

export const DropdownSearchable: Story = {
  render: () => <SearchableDropdownDemo />,
};

export const DropdownFlyoutSubmenu: Story = {
  render: () => <FlyoutSubmenuDropdownDemo />,
};

export const TooltipCompactControls: Story = {
  render: () => <CompactTooltipDemo />,
};

export const PopoverCompactSurface: Story = {
  render: () => <PopoverDemo />,
};

export const DialogSurface: Story = {
  render: () => <DialogDemo />,
};

export const DialogDangerSurface: Story = {
  render: () => <DialogDemo danger />,
};

export const SettingsPrimitives: Story = {
  render: () => <SettingsDemo />,
};

export const ToastGlobalStack: Story = {
  render: () => <ToastDemo />,
};

export const ShortcutKeycapsSurface: Story = {
  render: () => <ShortcutKeycapsDemo />,
};

export const WorkflowStatusIcons: Story = {
  render: () => <WorkflowStatusIconDemo />,
};
