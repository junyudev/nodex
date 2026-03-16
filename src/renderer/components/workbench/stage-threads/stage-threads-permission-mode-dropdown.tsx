import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "../../../lib/utils";
import type { CodexPermissionMode } from "../../../lib/types";
import {
  CheckmarkIcon,
  ChevronDownIcon,
  ConfigStatusIcon,
  PermissionDefaultIcon,
  PermissionFullAccessIcon,
} from "@/components/shared/icons";
import {
  SELECTOR_MENU_CONTENT_CLASS_NAME,
  SELECTOR_MENU_ITEM_CLASS_NAME,
} from "./selector-popover-primitives";

const PERMISSION_MODE_ITEMS: Array<{ value: CodexPermissionMode; label: string }> = [
  { value: "sandbox", label: "Workspace sandbox" },
  { value: "full-access", label: "Full access" },
  { value: "custom", label: "Custom (config.toml)" },
];

const PERMISSION_MODE_DEFAULT_TOOLTIP =
  "Codex automatically runs commands in a workspace sandbox and asks before protected actions.";
const PERMISSION_MODE_FULL_ACCESS_TOOLTIP =
  "Codex has full access over your computer and bypasses approval prompts (elevated risk).";
const PERMISSION_MODE_CUSTOM_TOOLTIP_FALLBACK =
  "Codex uses the permission defined in config.toml.";

function formatPermissionModeLabel(mode: CodexPermissionMode): string {
  const match = PERMISSION_MODE_ITEMS.find((item) => item.value === mode);
  return match?.label ?? "Workspace sandbox";
}

function resolvePermissionModeTooltip(
  mode: CodexPermissionMode,
  customDescription: string | null,
): string {
  if (mode === "sandbox") return PERMISSION_MODE_DEFAULT_TOOLTIP;
  if (mode === "full-access") return PERMISSION_MODE_FULL_ACCESS_TOOLTIP;
  return customDescription?.trim() || PERMISSION_MODE_CUSTOM_TOOLTIP_FALLBACK;
}

function PermissionModeMenuIcon({ mode }: { mode: CodexPermissionMode }) {
  if (mode === "sandbox") return <PermissionDefaultIcon className="shrink-0" />;
  if (mode === "full-access") return <PermissionFullAccessIcon className="shrink-0" />;
  return <ConfigStatusIcon className="shrink-0" />;
}

export function PermissionModeDropdown({
  selectedMode,
  customDescription,
  onSelect,
}: {
  selectedMode: CodexPermissionMode;
  customDescription: string | null;
  onSelect: (mode: CodexPermissionMode) => void;
}) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label="Permission mode"
          className="inline-flex h-7 min-w-0 items-center gap-1 rounded-full border border-transparent px-1.5 text-sm/4.5 text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground"
        >
          <PermissionModeMenuIcon mode={selectedMode} />
          <span className="max-w-40 truncate text-left text-sm">
            {formatPermissionModeLabel(selectedMode)}
          </span>
          <ChevronDownIcon />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            SELECTOR_MENU_CONTENT_CLASS_NAME,
            "outline-none",
          )}
        >
          {PERMISSION_MODE_ITEMS.map((item) => (
            <DropdownMenuPrimitive.Item
              key={item.value}
              onSelect={() => onSelect(item.value)}
              className={cn(
                SELECTOR_MENU_ITEM_CLASS_NAME,
              )}
            >
              <Tooltip
                content={resolvePermissionModeTooltip(item.value, customDescription)}
                side="right"
                sideOffset={12}
              >
                <div className="flex w-full items-center gap-2">
                  <PermissionModeMenuIcon mode={item.value} />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.value === selectedMode ? <CheckmarkIcon className="shrink-0 text-token-foreground" /> : null}
                </div>
              </Tooltip>
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
