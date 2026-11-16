import { presentAccentPresetLabel } from "./accent-color-presentation";
import { FormattedMessage, useIntl } from "@/lib/i18n";
import { CheckmarkIcon, ChevronRightIcon, MoonIcon, SunIcon } from "@/components/shared/icons";
import type { CommandPaletteCommand } from "@/lib/command-palette";
import {
  CODEX_ACCENT_PRESETS,
  codexAccentPresetLabel,
  getCodexThemeVariantStyle,
} from "@/lib/codex-theme-variant";
import { useTheme } from "@/lib/use-theme";

/** Theme commands write through the same per-appearance preferences as Settings. */
export function useCommandPaletteTheme() {
  const intl = useIntl();
  const { resolved, accent, setTheme, setAccent } = useTheme();
  const currentLabel =
    accent.kind === "custom"
      ? intl.formatMessage({ id: "workbench.commandPaletteTheme.custom", defaultMessage: "Custom" })
      : presentAccentPresetLabel(accent.name, resolved, intl);
  const parentCommand: CommandPaletteCommand = {
    kind: "command",
    id: "theme",
    title: intl.formatMessage({
      id: "workbench.commandPaletteTheme.theme",
      defaultMessage: "Theme",
    }),
    subtitle: currentLabel,
    keywords: ["Theme", "appearance", "color", "preset", "dark", "light", "night", currentLabel],
    group: "Configure",
    priority: 0,
    themeAction: "open",
  };
  const nextMode = resolved === "dark" ? "light" : "dark";
  const pageCommands: CommandPaletteCommand[] = [
    {
      kind: "command",
      id: `theme:${nextMode}`,
      title: intl.formatMessage(
        {
          id: "workbench.commandPaletteTheme.switchTheme",
          defaultMessage:
            "{mode, select, dark {Switch to dark theme} other {Switch to light theme}}",
        },
        { mode: nextMode },
      ),
      subtitle: "",
      keywords: [
        `Switch to ${nextMode} theme`,
        "toggle",
        "switch",
        "appearance",
        "dark",
        "light",
        "night",
      ],
      group: "Suggested",
      priority: 0,
      themeAction: nextMode,
    },
    ...CODEX_ACCENT_PRESETS.map((name, index): CommandPaletteCommand => {
      const style = getCodexThemeVariantStyle(resolved, { kind: "preset", name });
      return {
        kind: "command",
        id: `theme:accent:${name}`,
        title: presentAccentPresetLabel(name, resolved, intl),
        subtitle: intl.formatMessage(
          {
            id: "workbench.commandPaletteTheme.colorTheme",
            defaultMessage: "{mode, select, dark {Dark color theme} other {Light color theme}}",
          },
          { mode: resolved },
        ),
        keywords: [
          "theme",
          "color",
          "appearance",
          "preset",
          codexAccentPresetLabel(name, resolved),
        ],
        group: "Color themes",
        priority: index + 1,
        active: accent.kind === "preset" && accent.name === name,
        themeAction: name,
        themePreview: {
          surface: style["--codex-base-surface"]!,
          ink: style["--codex-base-ink"]!,
          accent: style["--codex-base-accent"]!,
        },
      };
    }),
  ];
  const execute = (commandId: string): boolean => {
    const action = pageCommands.find((command) => command.id === commandId)?.themeAction;
    if (!action || action === "open") return false;
    if (action === "light" || action === "dark") setTheme(action);
    else setAccent({ kind: "preset", name: action });
    return true;
  };
  return { parentCommand, pageCommands, execute };
}

export function CommandPaletteThemeRow({ item }: { item: CommandPaletteCommand }) {
  const { resolved } = useTheme();
  const variant = item.themeAction === "open" ? resolved : item.themeAction;
  const Glyph = variant === "dark" ? MoonIcon : SunIcon;
  const preview = item.themePreview;
  return (
    <div className="flex w-full items-center gap-2">
      {!preview ? <Glyph className="size-4 shrink-0 text-token-description-foreground" /> : null}
      <span className="min-w-0 flex-1 truncate">
        {item.searchTitleSegments
          ? item.searchTitleSegments.map((segment, index) => (
              <span key={index} className={segment.highlight ? "font-semibold" : undefined}>
                {segment.text}
              </span>
            ))
          : item.title}
      </span>
      {item.subtitle ? (
        <span className="min-w-0 truncate text-token-description-foreground">{item.subtitle}</span>
      ) : null}
      {preview ? (
        <span
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center rounded-full border-[0.5px] text-xs leading-none font-semibold"
          style={{
            backgroundColor: preview.surface,
            borderColor: `color-mix(in srgb, ${preview.ink} 16%, ${preview.surface})`,
            color: preview.accent,
          }}
        >
          Aa
        </span>
      ) : null}
      {item.active ? (
        <>
          <span className="sr-only">
            <FormattedMessage
              id="workbench.commandPaletteTheme.currentTheme"
              defaultMessage={"Current theme"}
            />
          </span>
          <CheckmarkIcon className="size-4 shrink-0" />
        </>
      ) : null}
      {item.themeAction === "open" ? <ChevronRightIcon className="size-4 shrink-0" /> : null}
    </div>
  );
}
