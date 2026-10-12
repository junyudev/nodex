import { useState } from "react";
import { HexColorPicker } from "react-colorful";

import { NodexOptionPicker, NodexSettingsDropdownTrigger } from "@/components/ui/dropdown";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import {
  CODEX_ACCENT_PRESETS,
  getCodexAccentStyle,
  normalizeCodexAccentColor,
  resolveEffectiveCodexAccent,
  type CodexAccentPreset,
} from "@/lib/codex-theme-variant";
import { useTheme } from "@/lib/use-theme";

const ACCENT_LABELS: Record<CodexAccentPreset, string> = {
  default: "Default",
  blue: "Blue",
  green: "Green",
  yellow: "Yellow",
  pink: "Pink",
  orange: "Orange",
  purple: "Purple",
  black: "Black",
};

function accentLabel(name: CodexAccentPreset, variant: "light" | "dark"): string {
  if (name === "black" && variant === "dark") return "White";
  return ACCENT_LABELS[name];
}

function accentSwatch(name: CodexAccentPreset, variant: "light" | "dark"): string {
  if (name !== "default" && name !== "black") return `var(--brand-${name}-400)`;
  return getCodexAccentStyle(variant, { kind: "preset", name })[
    "--color-background-composer-primary"
  ];
}

function AccentSwatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="size-3 shrink-0 rounded-full border border-default"
      style={{ backgroundColor: color }}
    />
  );
}

function CustomAccentColorInput({
  color,
  label,
  onChange,
}: {
  color: string;
  label: string;
  onChange: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  const updateHex = (input: string) => {
    const value = `#${input
      .toUpperCase()
      .replace(/[^0-9A-F]/g, "")
      .slice(0, 6)}`;
    const valid = normalizeCodexAccentColor(value);
    if (valid === null) {
      setDraft(value);
      return;
    }
    setDraft(null);
    onChange(valid);
  };

  return (
    <NodexPopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setDraft(null);
      }}
    >
      <div className="relative flex h-7 w-24 shrink-0 items-center gap-2 rounded-full border border-default px-2 focus-within:ring-2 focus-within:ring-ring">
        <NodexPopoverTrigger>
          <button
            type="button"
            aria-label={`Choose ${label.toLowerCase()}`}
            className="size-3.5 shrink-0 cursor-interaction rounded-full border border-default"
            style={{ backgroundColor: color }}
          />
        </NodexPopoverTrigger>
        <input
          aria-label={label}
          className="min-w-0 flex-1 bg-transparent text-xs uppercase tabular-nums outline-hidden"
          spellCheck={false}
          type="text"
          value={(draft ?? color).toUpperCase()}
          onBlur={() => setDraft(null)}
          onChange={(event) => updateHex(event.currentTarget.value)}
        />
      </div>
      <NodexPopoverContent align="end" sideOffset={8} initialFocus={false} className="w-auto p-3">
        <HexColorPicker
          aria-label={`Choose ${label.toLowerCase()}`}
          className="h-34! w-34!"
          color={color}
          onChange={onChange}
        />
      </NodexPopoverContent>
    </NodexPopover>
  );
}

export function AccentColorSettingControl() {
  const { accent, resolved, setAccent } = useTheme();
  const effectiveAccent = resolveEffectiveCodexAccent(accent);
  const variantLabel = resolved === "light" ? "Light" : "Dark";
  const value = accent.kind === "custom" ? "custom" : accent.name;
  const label = accent.kind === "custom" ? "Custom" : accentLabel(accent.name, resolved);
  const chooseAccent = (next: string) => {
    if (next === "custom") {
      const color = getCodexAccentStyle(resolved, effectiveAccent)["--codex-base-accent"];
      setAccent({ kind: "custom", color });
      return;
    }
    const name = CODEX_ACCENT_PRESETS.find((preset) => preset === next);
    if (name === undefined) return;
    setAccent({ kind: "preset", name });
  };
  const updateCustomAccent = (color: string) => setAccent({ kind: "custom", color });

  return (
    <div className="flex min-w-0 items-center gap-2">
      <NodexOptionPicker
        search="none"
        align="end"
        contentWidth="menu"
        value={value}
        options={[
          ...CODEX_ACCENT_PRESETS.map((name) => ({
            value: name,
            label: accentLabel(name, resolved),
            leftSlot: <AccentSwatch color={accentSwatch(name, resolved)} />,
          })),
          { value: "custom", label: "Custom" },
        ]}
        onValueChange={chooseAccent}
        triggerButton={
          <NodexSettingsDropdownTrigger
            aria-label={`${variantLabel} accent color`}
            className="w-36"
          >
            {effectiveAccent.kind === "preset" ? (
              <AccentSwatch color={accentSwatch(effectiveAccent.name, resolved)} />
            ) : null}
            <span className="truncate">{label}</span>
          </NodexSettingsDropdownTrigger>
        }
      />
      {accent.kind === "custom" ? (
        <CustomAccentColorInput
          key={resolved}
          color={accent.color}
          label={`${variantLabel} custom accent color`}
          onChange={updateCustomAccent}
        />
      ) : null}
    </div>
  );
}
