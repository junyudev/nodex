import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentType } from "react";
import * as AppIcons from "./icons";
import * as GenericIcons from "./icons/generic-icons";

type PreviewIcon = ComponentType<{ className?: string }>;

const APP_ICON_NAMES = [
  "NewChatIcon",
  "SettingsGeneralIcon",
  "ArchiveIcon",
  "FolderIcon",
  "FolderOpenIcon",
  "FileIcon",
  "PageIcon",
  "DatabaseIcon",
  "BoardIcon",
  "CanvasIcon",
  "ProjectActionsIcon",
  "ProjectAccessIcon",
  "MoveToIcon",
  "OpenInIcon",
  "SidePanelBrowserIcon",
  "SidePanelFilesIcon",
  "SidePanelReviewIcon",
  "SidePanelSideChatIcon",
  "SidePanelTerminalIcon",
  "BrowserBackIcon",
  "BrowserReloadIcon",
  "SearchIcon",
  "CalendarIcon",
  "CalendarOverdueIcon",
  "ClockIcon",
  "BellIcon",
  "PriorityIcon",
  "AssigneeIcon",
  "MultiSelectIcon",
  "TagsIcon",
  "ActivitySpinnerIcon",
] as const satisfies readonly (keyof typeof AppIcons)[];

const appIconEntries = APP_ICON_NAMES.map((name) => [name, AppIcons[name] as PreviewIcon] as const);

const genericIconEntries = Object.entries(GenericIcons)
  .map(([name, Icon]) => [name, Icon as unknown as PreviewIcon] as const)
  .sort(([left], [right]) => left.localeCompare(right));

function IconCell({ name, Icon }: { readonly name: string; readonly Icon: PreviewIcon }) {
  return (
    <div className="group min-w-0 rounded-lg bg-token-main-surface-primary px-3 py-2.5 shadow-[inset_0_0_0_0.5px_var(--border-token)]">
      <div className="flex h-7 items-center gap-3 text-token-text-secondary group-hover:text-token-text-primary">
        <Icon className="icon-2xs shrink-0" />
        <Icon className="icon-xs shrink-0" />
        <Icon className="icon-sm shrink-0" />
      </div>
      <div className="mt-2 truncate font-mono text-[11px] text-token-description-foreground">
        {name}
      </div>
    </div>
  );
}

function IconSection({
  title,
  description,
  entries,
}: {
  readonly title: string;
  readonly description: string;
  readonly entries: readonly (readonly [string, PreviewIcon])[];
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-sm font-medium text-token-text-primary">{title}</h2>
        <p className="text-xs text-token-description-foreground">{description}</p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
        {entries.map(([name, Icon]) => (
          <IconCell key={name} name={name} Icon={Icon} />
        ))}
      </div>
    </section>
  );
}

function IconGallery() {
  return (
    <main className="min-h-screen bg-token-main-surface-secondary px-8 py-7 text-token-text-primary">
      <header className="mb-8 max-w-2xl">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">Icon system</h1>
        <p className="mt-1 text-sm leading-5 text-token-text-secondary">
          App-owned semantic glyphs lead shell and resource identity. Curated generic glyphs share
          the same 16px default, 1.75 stroke, and decorative behavior.
        </p>
        <div className="mt-3 flex gap-4 font-mono text-[11px] text-token-description-foreground">
          <span>14 · icon-2xs</span>
          <span>16 · icon-xs</span>
          <span>18 · icon-sm</span>
        </div>
      </header>
      <div className="space-y-9">
        <IconSection
          title="App-owned"
          description={`${appIconEntries.length} representative semantic glyphs`}
          entries={appIconEntries}
        />
        <IconSection
          title="Generic adapter"
          description={`${genericIconEntries.length} actively used fallback glyphs`}
          entries={genericIconEntries}
        />
      </div>
    </main>
  );
}

const meta = {
  title: "Foundations/Icons",
  component: IconGallery,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof IconGallery>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Catalog: Story = {};
