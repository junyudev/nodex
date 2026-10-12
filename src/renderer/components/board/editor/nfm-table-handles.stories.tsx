import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowLeft, ArrowRight, CircleX } from "@/components/shared/icons/generic-icons";
import type { ReactNode } from "react";
import {
  CheckmarkIcon,
  NfmSideMenuColorIcon,
  NfmSideMenuDeleteIcon,
  NfmSideMenuDuplicateIcon,
} from "@/components/shared/icons";

function StaticRow({
  children,
  disabled = false,
  icon,
  rightSlot,
  subTrigger = false,
}: {
  children: string;
  disabled?: boolean;
  icon: ReactNode;
  rightSlot?: string;
  subTrigger?: boolean;
}) {
  return (
    <div
      data-disabled={disabled ? "" : undefined}
      data-slot={subTrigger ? "dropdown-menu-sub-trigger" : "dropdown-menu-item"}
      data-state={subTrigger ? "open" : undefined}
      role="menuitem"
    >
      <span className="bn-table-menu-item-icon">{icon}</span>
      <span className="bn-table-menu-item-label">{children}</span>
      {rightSlot ? <span className="bn-table-menu-item-right">{rightSlot}</span> : null}
      {subTrigger ? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="m6 4 4 4-4 4"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        </svg>
      ) : null}
    </div>
  );
}

function StaticColorRow({
  children,
  color,
  selected,
}: {
  children: string;
  color: string;
  selected?: boolean;
}) {
  return (
    <div data-slot="dropdown-menu-item" role="menuitem">
      <span
        className="bn-table-color-dot"
        data-nfm-table-color-kind="background"
        data-nfm-table-color-selected={selected ? "true" : undefined}
        style={{
          backgroundColor: color,
          boxShadow: `inset 0 0 0 ${selected ? 2 : 1}px ${selected ? "var(--color-token-focus-border)" : "var(--color-token-border)"}`,
        }}
      />
      <span className="bn-table-menu-item-label">{children}</span>
      {selected ? (
        <span className="bn-table-menu-item-right">
          <CheckmarkIcon className="size-4 shrink-0" />
        </span>
      ) : null}
    </div>
  );
}

function TableHandleMenuStory() {
  return (
    <div className="nfm-editor flex min-h-[420px] gap-4 bg-token-background p-8 text-token-foreground">
      <div className="bn-table-handle-menu" role="menu" aria-label="Table column menu">
        <StaticRow icon={<NfmSideMenuColorIcon />} subTrigger>
          Color
        </StaticRow>
        <StaticRow icon={<ArrowLeft className="size-5" aria-hidden="true" />}>
          Insert left
        </StaticRow>
        <StaticRow icon={<ArrowRight className="size-5" aria-hidden="true" />}>
          Insert right
        </StaticRow>
        <StaticRow icon={<NfmSideMenuDuplicateIcon />} rightSlot="⌘D">
          Duplicate
        </StaticRow>
        <StaticRow icon={<CircleX className="size-5" aria-hidden="true" />}>
          Clear contents
        </StaticRow>
        <StaticRow icon={<NfmSideMenuDeleteIcon />}>Delete</StaticRow>
      </div>

      <div className="bn-table-color-picker-dropdown" role="menu" aria-label="Table color menu">
        <div className="bn-table-color-picker-label">Background color</div>
        <StaticColorRow color="transparent">Default</StaticColorRow>
        <StaticColorRow color="color-mix(in srgb, var(--color-token-foreground) 12%, transparent)">
          Gray
        </StaticColorRow>
        <StaticColorRow color="color-mix(in srgb, var(--blue-300) 22%, transparent)" selected>
          Blue
        </StaticColorRow>
        <StaticColorRow color="color-mix(in srgb, var(--color-token-charts-red) 24%, transparent)">
          Red
        </StaticColorRow>
      </div>
    </div>
  );
}

const meta = {
  title: "Board/Editor/NFM Table Handles",
  component: TableHandleMenuStory,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof TableHandleMenuStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const TableHandleMenu: Story = {};
