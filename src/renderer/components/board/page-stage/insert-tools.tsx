import { defineMessage, getIntl, subscribeAppLocale, useIntl } from "@/lib/i18n";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Photo16Glyph, TextFormat16Glyph } from "@/components/shared/icons/outline-glyphs";
import { PlusSquareLightIcon, TableLightIcon } from "@/components/shared/icons/page-chrome-icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSectionLabel,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { ViewerControlButton, ViewerControlGroup } from "@/components/ui/viewer-header";
import { groupPageInsertItems } from "@/lib/page-insert-menu";
import { cn } from "@/lib/utils";
import type { NfmEditorCommands, NfmInsertItem } from "../editor/nfm-editor-commands";
import { NfmTurnIntoBlockIcon, type NfmTurnIntoBlockKey } from "../editor/nfm-turn-into-block-icon";
import { TEXT_STYLE_MESSAGES } from "../presentation-messages";

/** The styles a line of prose takes: text and headings, then lists. */
const TEXT_STYLE_GROUPS = [
  ["paragraph", "heading-1", "heading-2", "heading-3"],
  ["bullet-list", "numbered-list", "todo-list", "toggle-list"],
] as const;

/** Catalog entries that set a line's style; the Text style menu owns those. */
const LINE_STYLE_INSERT_KEYS: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "heading_2",
  "heading_3",
  "toggle_heading",
  "toggle_heading_2",
  "toggle_heading_3",
  "bullet_list",
  "numbered_list",
  "check_list",
  "toggle_list",
]);

const inlineSectionMessage = defineMessage({
  id: "board.insertTools.inlineSection",
  defaultMessage: "Inline",
});

/** Toolbar clicks must not take focus from the body, so the caret stays where it was. */
const keepEditorFocus = (event: MouseEvent) => event.preventDefault();

/**
 * A menu choice that acts on the body's caret runs once the menu has closed: an open menu holds
 * focus, and the body can only take it back afterwards.
 */
function useChoiceAfterClose(commands: NfmEditorCommands | null) {
  const pendingRef = useRef<(() => void) | null>(null);
  return {
    choose: (action: () => void) => {
      pendingRef.current = action;
    },
    reset: () => {
      pendingRef.current = null;
    },
    finalFocus: () => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      // Dismissing without a choice still returns to the body the tools belong to.
      requestAnimationFrame(pending ?? (() => commands?.focus()));
      return false;
    },
  };
}

function TextStyleMenu({
  commands,
  disabled,
  className,
}: {
  readonly commands: NfmEditorCommands | null;
  readonly disabled: boolean;
  readonly className?: string;
}) {
  const intl = useIntl();

  const [currentKey, setCurrentKey] = useState<NfmTurnIntoBlockKey | null>(null);
  const choice = useChoiceAfterClose(commands);
  return (
    <NodexDropdownMenu
      align="start"
      side="bottom"
      sideOffset={8}
      contentWidth="menu"
      contentClassName="outline-hidden"
      disabled={disabled}
      onOpenChange={(open) => {
        if (!open) return;
        choice.reset();
        setCurrentKey(commands?.readTurnIntoKey() ?? null);
      }}
      finalFocus={choice.finalFocus}
      triggerButton={
        <ViewerControlButton
          label={intl.formatMessage({
            id: "board.insertTools.textStyle",
            defaultMessage: "Text style",
          })}
          disabled={disabled}
          onMouseDown={keepEditorFocus}
          className={className}
        >
          <TextFormat16Glyph />
        </ViewerControlButton>
      }
    >
      {TEXT_STYLE_GROUPS.map((group, groupIndex) => (
        <div key={group[0]}>
          {groupIndex > 0 ? <NodexDropdownSeparator /> : null}
          {group.map((key) => (
            <NodexDropdownItem
              key={key}
              leftSlot={<NfmTurnIntoBlockIcon targetKey={key} />}
              rightSlot={currentKey === key ? <NodexDropdownSelectedIcon /> : null}
              onSelect={() => choice.choose(() => commands?.turnInto(key))}
            >
              {intl.formatMessage(TEXT_STYLE_MESSAGES[key])}
            </NodexDropdownItem>
          ))}
        </div>
      ))}
    </NodexDropdownMenu>
  );
}

function InsertMenu({
  commands,
  disabled,
  className,
}: {
  readonly commands: NfmEditorCommands | null;
  readonly disabled: boolean;
  readonly className?: string;
}) {
  const intl = useIntl();

  const [items, setItems] = useState<readonly NfmInsertItem[]>([]);
  const openRef = useRef(false);
  const choice = useChoiceAfterClose(commands);
  useEffect(
    () =>
      subscribeAppLocale(() => {
        if (openRef.current) setItems(commands?.listInsertItems(getIntl()) ?? []);
      }),
    [commands],
  );
  return (
    <NodexDropdownMenu
      align="start"
      side="bottom"
      sideOffset={8}
      contentWidth="panelWide"
      contentMaxHeight="tall"
      contentClassName="overflow-y-auto outline-hidden"
      disabled={disabled}
      onOpenChange={(open) => {
        openRef.current = open;
        if (!open) return;
        choice.reset();
        setItems(commands?.listInsertItems(intl) ?? []);
      }}
      finalFocus={choice.finalFocus}
      triggerButton={
        <ViewerControlButton
          label={intl.formatMessage({ id: "board.insertTools.insert", defaultMessage: "Insert" })}
          disabled={disabled}
          onMouseDown={keepEditorFocus}
          className={className}
        >
          <PlusSquareLightIcon />
        </ViewerControlButton>
      }
    >
      {groupPageInsertItems(
        items.map((item) => ({ key: item.key, group: item.groupKey ?? item.group, item })),
        LINE_STYLE_INSERT_KEYS,
      ).map((section) => {
        const label =
          section.label === "Inline"
            ? intl.formatMessage(inlineSectionMessage)
            : (section.items[0]?.item.group ?? section.label);
        return (
          <div key={section.label} role="group" aria-label={label}>
            <NodexDropdownSectionLabel>{label}</NodexDropdownSectionLabel>
            {section.items.map(({ item }) => (
              <NodexDropdownItem
                key={item.key}
                aria-label={item.title}
                leftSlot={item.icon}
                keyboardShortcut={
                  item.hint ? (
                    <kbd className="rounded-md bg-token-foreground/5 px-1.5 py-0.5 font-sans leading-none">
                      {item.hint}
                    </kbd>
                  ) : null
                }
                onSelect={() => choice.choose(() => commands?.insert(item.key))}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="max-w-[60%] flex-none truncate">{item.title}</span>
                  {item.description ? (
                    <span className="min-w-0 flex-1 truncate text-token-description-foreground">
                      {item.description}
                    </span>
                  ) : null}
                </span>
              </NodexDropdownItem>
            ))}
          </div>
        );
      })}
    </NodexDropdownMenu>
  );
}

/**
 * The Page's authoring tools on one capsule: the style of the line at the caret, the two Blocks a
 * body most often needs, and everything else it can insert. They act on the body's caret, so
 * they never take its focus.
 */
export function PageStageInsertTools({
  commands,
  pending = false,
}: {
  /** Absent while the body editor is not showing, as when the Page shows its source. */
  readonly commands: NfmEditorCommands | null;
  /** The Page is still opening: the tools are inert but keep their resting appearance. */
  readonly pending?: boolean;
}) {
  const intl = useIntl();

  const disabled = pending || !commands;
  const className = cn(pending && "disabled:opacity-100");
  return (
    <ViewerControlGroup
      label={intl.formatMessage({
        id: "board.insertTools.editingTools",
        defaultMessage: "Page editing tools",
      })}
    >
      <span className="inline-flex items-center gap-0.5" data-viewer-header-collapsible="">
        <TextStyleMenu commands={commands} disabled={disabled} className={className} />
        <ViewerControlButton
          label={intl.formatMessage({ id: "board.insertTools.image", defaultMessage: "Image" })}
          disabled={disabled}
          onMouseDown={keepEditorFocus}
          onClick={() => commands?.insert("image")}
          className={className}
        >
          <Photo16Glyph />
        </ViewerControlButton>
        <ViewerControlButton
          label={intl.formatMessage({ id: "board.insertTools.table", defaultMessage: "Table" })}
          disabled={disabled}
          onMouseDown={keepEditorFocus}
          onClick={() => commands?.insert("table")}
          className={className}
        >
          <TableLightIcon />
        </ViewerControlButton>
      </span>
      <InsertMenu commands={commands} disabled={disabled} className={className} />
    </ViewerControlGroup>
  );
}
