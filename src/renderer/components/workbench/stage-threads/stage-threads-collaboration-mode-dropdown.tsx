import type { CodexCollaborationModeKind, CodexCollaborationModePreset } from "@/lib/types";
import { ToolbarDropdownMenu } from "./stage-threads-toolbar-dropdown-menu";

function fallbackModeLabel(mode: CodexCollaborationModeKind): string {
  return mode === "plan" ? "Plan" : "Default";
}

export function StageThreadsCollaborationModeDropdown({
  collaborationModes,
  selectedMode,
  onSelect,
}: {
  collaborationModes: CodexCollaborationModePreset[];
  selectedMode: CodexCollaborationModeKind;
  onSelect: (mode: CodexCollaborationModeKind) => void;
}) {
  if (collaborationModes.length === 0) {
    return (
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1 rounded-full border border-transparent px-2 text-sm/4.5 text-(--foreground-secondary) opacity-50"
        disabled
        title="Collaboration modes unavailable"
        aria-label="Collaboration modes unavailable"
      >
        <span>{fallbackModeLabel(selectedMode)}</span>
      </button>
    );
  }

  const selectedLabel =
    collaborationModes.find((preset) => preset.mode === selectedMode)?.name
    ?? fallbackModeLabel(selectedMode);

  return (
    <ToolbarDropdownMenu
      label={selectedLabel}
      title="Select collaboration mode"
      ariaLabel="Select collaboration mode"
      items={collaborationModes.map((preset) => ({
        value: preset.mode,
        label: preset.name,
      }))}
      selectedValue={selectedMode}
      onSelect={(value) => {
        if (value === "default" || value === "plan") {
          onSelect(value);
        }
      }}
    />
  );
}
