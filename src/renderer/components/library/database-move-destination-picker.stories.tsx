import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useMemo, useState } from "react";

import { MoveToIcon } from "@/components/shared/icons";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
} from "@/components/ui/dropdown";
import {
  DatabaseMoveDestinationPickerSurface,
  type DatabaseMoveDestinationPickerSection,
} from "./database-move-destination-picker";

const pages = [
  {
    pageId: "page-product",
    title: "Product",
    path: ["Pages"],
    hasChildren: true,
    isCurrent: false,
    documentGeneration: 1,
    documentHeadSeq: 12,
    updatedAt: "2026-08-11T08:30:00.000Z",
  },
  {
    pageId: "page-roadmap",
    title: "Roadmap",
    path: ["Pages", "Product"],
    hasChildren: false,
    isCurrent: true,
    documentGeneration: 1,
    documentHeadSeq: 8,
    updatedAt: "2026-08-11T08:20:00.000Z",
  },
  {
    pageId: "page-research",
    title: "Research notes",
    path: ["Pages"],
    hasChildren: false,
    isCurrent: false,
    documentGeneration: 2,
    documentHeadSeq: 3,
    updatedAt: "2026-08-10T15:10:00.000Z",
  },
] as const;

function Story() {
  const [menuOpen, setMenuOpen] = useState(true);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [acceptingRowId, setAcceptingRowId] = useState<string | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setSubmenuOpen(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const sections = useMemo<readonly DatabaseMoveDestinationPickerSection[]>(() => {
    if (query.trim()) {
      const normalized = query.trim().toLowerCase();
      return [
        {
          key: "search",
          label: "Search results",
          rows: pages
            .filter((page) => page.title.toLowerCase().includes(normalized))
            .map((entry) => ({
              kind: "page",
              id: `search:${entry.pageId}`,
              entry,
              depth: 0,
              expanded: false,
              context: "search",
            })),
        },
      ];
    }
    return [
      {
        key: "recent",
        label: "Recent",
        rows: pages.slice(0, 2).map((entry) => ({
          kind: "page",
          id: `recent:${entry.pageId}`,
          entry,
          depth: 0,
          expanded: false,
          context: "recent",
        })),
      },
      {
        key: "pages",
        label: "Pages",
        rows: [
          {
            kind: "root",
            id: "library-root",
            label: "Pages",
            metadata: "Top level",
            disabled: false,
          },
          {
            kind: "page",
            id: "tree:page-product",
            entry: pages[0],
            depth: 0,
            expanded,
            context: "tree",
          },
          ...(expanded
            ? [
                {
                  kind: "page" as const,
                  id: "tree:page-roadmap",
                  entry: pages[1],
                  depth: 1,
                  expanded: false,
                  context: "tree" as const,
                },
              ]
            : []),
          {
            kind: "page",
            id: "tree:page-research",
            entry: pages[2],
            depth: 0,
            expanded: false,
            context: "tree",
          },
        ],
      },
    ];
  }, [expanded, query]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-token-main-surface-primary p-8">
      <NodexDropdownMenu
        triggerButton={
          <button
            type="button"
            className="h-8 rounded-lg bg-token-foreground/5 px-3 text-sm text-token-foreground hover:bg-token-foreground/10"
          >
            Resource actions
          </button>
        }
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) setSubmenuOpen(false);
        }}
        align="start"
      >
        <NodexDropdownFlyoutSubmenuItem
          label="Move to"
          leftSlot={<MoveToIcon />}
          open={submenuOpen}
          onOpenChange={setSubmenuOpen}
          contentClassName="w-[330px] max-w-[calc(100vw-24px)] overflow-hidden p-0"
          contentMotion="none"
        >
          <DatabaseMoveDestinationPickerSurface
            ariaLabel="Move Quarterly planning to"
            query={query}
            sections={sections}
            loading={false}
            stale={false}
            error={null}
            acceptingRowId={acceptingRowId}
            hasMore={false}
            onQueryChange={setQuery}
            onToggle={() => setExpanded((value) => !value)}
            onAccept={(row) => {
              setAcceptingRowId(row.id);
              window.setTimeout(() => setAcceptingRowId(null), 900);
            }}
            onClose={() => setSubmenuOpen(false)}
          />
        </NodexDropdownFlyoutSubmenuItem>
        <NodexDropdownItem>Manage access</NodexDropdownItem>
        <NodexDropdownItem>Archive</NodexDropdownItem>
      </NodexDropdownMenu>
    </div>
  );
}

const meta = {
  title: "Library/Database move destination picker",
  component: Story,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Story>;

export default meta;
type StoryDefinition = StoryObj<typeof meta>;

export const Submenu: StoryDefinition = {
  render: () => <Story />,
};
