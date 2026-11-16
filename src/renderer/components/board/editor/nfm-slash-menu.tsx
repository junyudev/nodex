import { en, zh } from "@blocknote/core/locales";
import { useIntl, getIntl, defineMessages, type MessageDescriptor } from "@/lib/i18n";
import { SkillMentionIcon } from "@/components/shared/skill-mention-icon";
import {
  pageSkillLocationsLabel,
  type PageSkillMention,
} from "@/features/skills/use-page-skill-mentions";
import { useSkillMentionPresentation } from "./skill-mention-chip";
import {
  matchesNodexAgentMention,
  NODEX_AGENT_MENTION_TITLE,
  turnCaretBlockIntoPrompt,
} from "./nfm-prompt-block-model";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import {
  startTransition,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  SuggestionMenu,
  filterSuggestionItems,
  insertOrUpdateBlockForSlashMenu,
  type SuggestionMenuOptions,
} from "@blocknote/core/extensions";
import {
  GridSuggestionMenuController,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useBlockNoteEditor,
  type DefaultReactSuggestionItem,
  type SuggestionMenuProps,
} from "@blocknote/react";
import { getMathSlashMenuItems } from "@blocknote/math-block";
import { Minus } from "@/components/shared/icons/generic-icons";
import {
  NodexDropdownActionRow,
  NodexDropdownMessage,
  NodexDropdownScrollList,
  NodexDropdownSectionLabel,
  NodexDropdownSurface,
} from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { NodexFloatingLayerProvider } from "@/components/ui/floating-layer";
import { cn } from "@/lib/utils";
import {
  chatHighlightSegments,
  mergeChatSearchMatches,
  preferChatProject,
  searchChatMessages,
  searchChats,
  searchesChatMessages,
} from "@/lib/chat-search";
import type { ChatCatalogEntry, ChatSearchMatch } from "../../../../shared/chat-search";
import {
  NFM_SUGGESTION_MENU_FLOATING_OPTIONS,
  NFM_SUGGESTION_MENU_PORTAL_ELEMENT,
  NFM_SUGGESTION_MENU_TOOLTIP_Z_INDEX,
  NFM_SUGGESTION_MENU_Z_INDEX,
} from "./nfm-blocknote-floating-ui";
import { formatThreadMentionShortUuid } from "@/lib/editor-model/thread-mention-display";
import {
  AskAiIcon,
  ChatIcon,
  BellIcon,
  CalendarIcon,
  ClockIcon,
  CanvasIcon,
  CodeIcon,
  ImageBlockIcon,
  NfmSideMenuPageInIcon,
  NfmTableBlockIcon,
  PageIcon,
  TextActionReactionIcon,
  TextActionEquationIcon,
  MoreActionsIcon,
  SettingsGeneralIcon,
} from "@/components/shared/icons";
import {
  buildLocalizedDateMentionQueryMatches,
  DATE_MENTION_LABEL_MESSAGES,
  type DateMentionQueryMatch,
} from "../../../../shared/rich-text/date-mention";
import type { DateMentionInlineContent } from "../../../../shared/rich-text/date-mention";
import { dateMentionPayloadToProps } from "./date-mention-inline-content";
import { useBlockReferenceHostRuntime } from "@/components/block-documents/block-reference-runtime-context";
import { toast } from "@/components/ui/toast";
import { setCanvasCreatePending } from "./canvas-create-pending-extension";
import {
  createPageReferenceSearchController,
  loadPageReferenceCandidatesSync,
} from "@/lib/page-reference-picker/search-controller";
import { presentPageReferenceCandidates } from "@/lib/page-reference-picker/candidate-model";
import type {
  PageReferenceCandidate,
  PageReferenceIntent,
} from "@/lib/page-reference-picker/types";
import {
  type MentionSuggestionFamily,
  type MentionSuggestionRank,
} from "@/lib/editor-model/mention-suggestion-model";
import type { Project } from "@/lib/types";
import type { CommandPaletteHighlightSegment } from "@/lib/command-palette-highlight";
import { StatusIcon } from "@/lib/status-presentation";
import { contentRoutingContextKey } from "../../../../shared/content-routing-context";
import { NFM_TURN_INTO_DEFINITIONS } from "@/lib/nfm-turn-into-targets";
import { codeLanguagePreference } from "@/lib/editor-model/code-language-preference";
import { NfmTurnIntoBlockIcon, type NfmTurnIntoBlockKey } from "./nfm-turn-into-block-icon";
import {
  evaluateNfmTypedSuggestionTrigger,
  getNfmSlashTriggerCharacters,
  isNfmInlineSkillToken,
  shouldCloseNfmSkillQuery,
  type NfmTypedSuggestionKind,
} from "@/lib/editor-model/editor-trigger-policy";
import {
  getNfmPageMentionEntryProfile,
  selectNfmPageMentionSections,
  type NfmPageMentionEntryProfile,
} from "@/lib/editor-model/page-mention-entrypoint";
import { useNfmPageMentionCreateFlow } from "./nfm-page-mention-create-flow";
import type { NfmSuggestionItem } from "./nfm-suggestion-item";
import { TEXT_STYLE_MESSAGES } from "../presentation-messages";

export { buildNfmPageMentionCreateSuggestionItems } from "./nfm-page-mention-create-flow";
export type { NfmSuggestionItem } from "./nfm-suggestion-item";

interface NfmSlashMenuProps {
  executionProjectId: string | null;
  allowPageReferences?: boolean;
  locale?: string;
  /** Receives a reader of the same catalog, for insert menus outside the editor. */
  catalogRef?: MutableRefObject<NfmInsertCatalogReader | null>;
}

export type NfmInsertCatalogReader = (intl?: ReturnType<typeof getIntl>) => NfmSuggestionItem[];

type UnsafeEditor = Parameters<typeof insertOrUpdateBlockForSlashMenu>[0];
type UnsafeBlock = Parameters<typeof insertOrUpdateBlockForSlashMenu>[1];
type UnsafeInlineContentEditor = {
  insertInlineContent: (content: unknown[], options?: { updateSelection?: boolean }) => void;
};

const PAGE_EMBED_PICKER_TRIGGER = "\uE000";
const SUBPAGE_NAME_TRIGGER = "\uE001";

function getBrowserLocale(): string {
  return typeof navigator === "undefined" ? "en-US" : navigator.language;
}

export function shouldCloseNfmSlashQuery(query: string): boolean {
  return query.endsWith("  ");
}

export function createNfmTypedSuggestionShouldOpen(input: {
  readonly kind: NfmTypedSuggestionKind;
  readonly trigger: string;
  readonly locale: string;
}): NonNullable<SuggestionMenuOptions["shouldOpen"]> {
  return (transaction) => {
    if (!transaction.selection.empty) return false;
    const { parent, parentOffset } = transaction.selection.$from;
    if (parent.type.spec.code) return false;
    if (
      input.kind === "skill-mention" &&
      (transaction.storedMarks ?? transaction.selection.$from.marks()).some(
        (mark) => mark.type.spec.code,
      )
    )
      return false;
    if (input.kind === "slash" && parent.type.isInGroup("tableContent")) return false;

    const textBeforeTrigger = parent.textBetween(
      0,
      Math.max(0, parentOffset - Math.max(0, input.trigger.length - 1)),
      undefined,
      "\ufffc",
    );
    return evaluateNfmTypedSuggestionTrigger({ ...input, textBeforeTrigger }).allowed;
  };
}

export function createNfmTypedSuggestionControllerConfig(
  locale: string,
  options: { readonly canCreatePageMention?: boolean } = {},
  intl = getIntl(),
) {
  const canCreatePageMention = options.canCreatePageMention ?? true;
  return {
    slash: getNfmSlashTriggerCharacters(locale).map((triggerCharacter) => ({
      triggerCharacter,
      temporaryInput: {
        enabled: true as const,
        emptyCompletion: intl.formatMessage({
          id: "editor.nfmSlashMenu.typeToSearch",
          defaultMessage: "Type to search",
        }),
      },
      shouldOpen: createNfmTypedSuggestionShouldOpen({
        kind: "slash",
        trigger: triggerCharacter,
        locale,
      }),
    })),
    skillMention: {
      triggerCharacter: "$",
      shouldOpen: createNfmTypedSuggestionShouldOpen({
        kind: "skill-mention",
        trigger: "$",
        locale,
      }),
    },
    pageMention: (["@", "+", "[["] as const).map((triggerCharacter) => ({
      triggerCharacter,
      profile: getNfmPageMentionEntryProfile(triggerCharacter),
      shouldOpen:
        triggerCharacter === "+" && !canCreatePageMention
          ? () => false
          : createNfmTypedSuggestionShouldOpen({
              kind: "page-mention",
              trigger: triggerCharacter,
              locale,
            }),
      autoCloseWhenNoItems: false,
    })),
    emoji: {
      triggerCharacter: ":",
      shouldOpen: createNfmTypedSuggestionShouldOpen({
        kind: "emoji",
        trigger: ":",
        locale,
      }),
      columns: 10,
      minQueryLength: 2,
    },
  } as const;
}

const SUGGESTION_SYNTAX_HINT_BY_KEY: Record<string, string> = {
  paragraph: "text",
  heading: "#",
  heading_2: "##",
  heading_3: "###",
  toggle_heading: "> #",
  toggle_heading_2: "> ##",
  toggle_heading_3: "> ###",
  quote: "|",
  toggle_list: ">",
  numbered_list: "1.",
  bullet_list: "-",
  check_list: "[]",
  code_block: "```",
  code_mermaid: "```mermaid",
  math_block: "$$",
  inline_math: "$x$",
  divider: "---",
  table: "table",
  image: "image",
  emoji: ":",
};

const slashTitles = defineMessages({
  emoji: { id: "editor.nfmSlashMenu.emoji", defaultMessage: "Emoji" },
  inlineEquation: { id: "editor.nfmSlashMenu.inlineEquation", defaultMessage: "Inline equation" },
  mermaid: { id: "editor.nfmSlashMenu.mermaid", defaultMessage: "Code - Mermaid" },
  blockEquation: { id: "editor.nfmSlashMenu.blockEquation", defaultMessage: "Block equation" },
  divider: { id: "editor.nfmSlashMenu.divider", defaultMessage: "Divider" },
  table: { id: "editor.nfmSlashMenu.table", defaultMessage: "Table" },
  image: { id: "editor.nfmSlashMenu.image", defaultMessage: "Image" },
  subpage: { id: "editor.nfmSlashMenu.subpage", defaultMessage: "Subpage" },
  mentionPage: { id: "editor.nfmSlashMenu.mentionPage", defaultMessage: "Mention a page" },
  embedPage: { id: "editor.nfmSlashMenu.embedPage", defaultMessage: "Embed page" },
  canvas: { id: "editor.nfmSlashMenu.canvas", defaultMessage: "Canvas" },
  agentConfig: { id: "editor.nfmSlashMenu.agentConfig", defaultMessage: "Agent Config" },
});

const slashGroups = defineMessages({
  text: { id: "editor.nfmSlashMenu.textGroup", defaultMessage: "Text" },
  lists: { id: "editor.nfmSlashMenu.listsGroup", defaultMessage: "Lists" },
  blocks: { id: "editor.nfmSlashMenu.blocksGroup", defaultMessage: "Blocks" },
  pages: { id: "editor.nfmSlashMenu.pagesGroup", defaultMessage: "Pages" },
  agent: { id: "editor.nfmSlashMenu.agentGroup", defaultMessage: "Agent" },
});

interface NfmSlashMenuItemPresentation {
  readonly key: string;
  readonly group: MessageDescriptor;
  readonly label?: MessageDescriptor;
  readonly turnIntoKey?: NfmTurnIntoBlockKey;
  readonly englishAlias?: string;
}

const NFM_SLASH_MENU_ITEM_PRESENTATIONS = [
  { key: "paragraph", group: slashGroups.text, turnIntoKey: "paragraph", englishAlias: "Text" },
  { key: "heading", group: slashGroups.text, turnIntoKey: "heading-1" },
  { key: "heading_2", group: slashGroups.text, turnIntoKey: "heading-2" },
  { key: "heading_3", group: slashGroups.text, turnIntoKey: "heading-3" },
  { key: "toggle_heading", group: slashGroups.text, turnIntoKey: "toggle-heading-1" },
  { key: "toggle_heading_2", group: slashGroups.text, turnIntoKey: "toggle-heading-2" },
  { key: "toggle_heading_3", group: slashGroups.text, turnIntoKey: "toggle-heading-3" },
  { key: "emoji", group: slashGroups.text, label: slashTitles.emoji },
  { key: "inline_math", group: slashGroups.text, label: slashTitles.inlineEquation },
  {
    key: "bullet_list",
    group: slashGroups.lists,
    turnIntoKey: "bullet-list",
    englishAlias: "Bulleted list",
  },
  { key: "numbered_list", group: slashGroups.lists, turnIntoKey: "numbered-list" },
  {
    key: "check_list",
    group: slashGroups.lists,
    turnIntoKey: "todo-list",
    englishAlias: "To-do list",
  },
  { key: "toggle_list", group: slashGroups.lists, turnIntoKey: "toggle-list" },
  { key: "quote", group: slashGroups.blocks, turnIntoKey: "quote" },
  { key: "callout", group: slashGroups.blocks, turnIntoKey: "callout" },
  { key: "code_block", group: slashGroups.blocks, turnIntoKey: "code" },
  { key: "code_mermaid", group: slashGroups.blocks, label: slashTitles.mermaid },
  { key: "math_block", group: slashGroups.blocks, label: slashTitles.blockEquation },
  { key: "divider", group: slashGroups.blocks, label: slashTitles.divider },
  { key: "table", group: slashGroups.blocks, label: slashTitles.table },
  { key: "image", group: slashGroups.blocks, label: slashTitles.image },
  { key: "subpage", group: slashGroups.pages, label: slashTitles.subpage },
  { key: "mention_page", group: slashGroups.pages, label: slashTitles.mentionPage },
  { key: "embed_page", group: slashGroups.pages, label: slashTitles.embedPage },
  { key: "canvas", group: slashGroups.pages, label: slashTitles.canvas },
  { key: "prompt", group: slashGroups.agent, turnIntoKey: "prompt" },
  { key: "agent_config", group: slashGroups.agent, label: slashTitles.agentConfig },
] as const satisfies readonly NfmSlashMenuItemPresentation[];

type NfmSlashMenuItemKey = (typeof NFM_SLASH_MENU_ITEM_PRESENTATIONS)[number]["key"];

const NFM_SLASH_MENU_ITEM_PRESENTATION_BY_KEY = new Map<string, NfmSlashMenuItemPresentation>(
  NFM_SLASH_MENU_ITEM_PRESENTATIONS.map((presentation) => [presentation.key, presentation]),
);

const NFM_TURN_INTO_DEFINITION_BY_KEY = new Map(
  NFM_TURN_INTO_DEFINITIONS.map((definition) => [definition.key, definition] as const),
);

function getNfmSlashMenuItemIcon(key: NfmSlashMenuItemKey, turnIntoKey?: NfmTurnIntoBlockKey) {
  if (turnIntoKey) return <NfmTurnIntoBlockIcon targetKey={turnIntoKey} />;
  if (key === "emoji") return <TextActionReactionIcon />;
  if (key === "divider") return <Minus size={20} className="size-5" />;
  if (key === "table") return <NfmTableBlockIcon />;
  if (key === "image") return <ImageBlockIcon />;
  if (key === "canvas") return <CanvasIcon className="size-5" />;
  if (key === "embed_page") return <NfmSideMenuPageInIcon />;
  if (key === "subpage" || key === "mention_page") return <PageIcon className="size-5" />;
  if (key === "math_block" || key === "inline_math") return <TextActionEquationIcon />;
  if (key === "code_mermaid") return <CodeIcon />;
  return <SettingsGeneralIcon className="size-5" />;
}

function localizeDefaultSlashItems(
  items: readonly DefaultReactSuggestionItem[],
  locale: string,
): NfmSuggestionItem[] {
  const dictionary = locale === "zh-CN" ? zh : en;
  return items.map((item: NfmSuggestionItem) => {
    const key = item.key as keyof typeof en.slash_menu;
    const presentation = dictionary.slash_menu[key];
    if (!presentation) return item;
    if (locale !== "zh-CN") return { ...item, ...presentation };

    const englishItem = en.slash_menu[key];
    return {
      ...item,
      ...presentation,
      aliases: [...presentation.aliases, ...englishItem.aliases, englishItem.title],
    };
  });
}

function presentNfmSlashMenuItem(
  item: NfmSuggestionItem,
  intl: ReturnType<typeof getIntl>,
): NfmSuggestionItem | null {
  const key = item.key;
  if (!key) return null;

  const presentation = NFM_SLASH_MENU_ITEM_PRESENTATION_BY_KEY.get(key);
  if (!presentation) return null;

  const turnIntoDefinition = presentation.turnIntoKey
    ? NFM_TURN_INTO_DEFINITION_BY_KEY.get(presentation.turnIntoKey)
    : undefined;
  const titleMessage =
    TEXT_STYLE_MESSAGES[presentation.turnIntoKey as keyof typeof TEXT_STYLE_MESSAGES] ??
    presentation.label;

  return {
    ...item,
    key,
    title: titleMessage
      ? intl.formatMessage(titleMessage)
      : (turnIntoDefinition?.label ?? item.title),
    group: intl.formatMessage(presentation.group),
    insertGroupKey:
      typeof presentation.group.defaultMessage === "string"
        ? presentation.group.defaultMessage
        : undefined,
    aliases:
      intl.locale === "zh-CN"
        ? [
            ...(item.aliases ?? []),
            presentation.label?.defaultMessage,
            presentation.englishAlias,
          ].filter((alias): alias is string => typeof alias === "string")
        : item.aliases,
    icon:
      getNfmSlashMenuItemIcon(key as NfmSlashMenuItemKey, presentation.turnIntoKey) ?? item.icon,
  };
}

/** Builds the complete Nodex-owned slash catalog in one deterministic pass. */
export function buildNfmSlashMenuItems(
  defaultItems: readonly DefaultReactSuggestionItem[],
  customItems: readonly NfmSuggestionItem[],
  intl = getIntl(),
): NfmSuggestionItem[] {
  const itemByKey = new Map<string, NfmSuggestionItem>();

  for (const defaultItem of defaultItems) {
    const keyedItem = defaultItem as NfmSuggestionItem;
    if (keyedItem.key === "table") continue;

    const presentedItem = presentNfmSlashMenuItem(keyedItem, intl);
    if (presentedItem?.key) itemByKey.set(presentedItem.key, presentedItem);
  }

  for (const customItem of customItems) {
    const presentedItem = presentNfmSlashMenuItem(customItem, intl);
    if (presentedItem?.key) itemByKey.set(presentedItem.key, presentedItem);
  }

  return NFM_SLASH_MENU_ITEM_PRESENTATIONS.flatMap(({ key }) => {
    const item = itemByKey.get(key);
    return item ? [item] : [];
  });
}

export const NFM_SUGGESTION_MENU_CONTROLLER_PORTAL_PROPS = {
  portalElement: NFM_SUGGESTION_MENU_PORTAL_ELEMENT,
  floatingUIOptions: NFM_SUGGESTION_MENU_FLOATING_OPTIONS,
} as const;

function insertBlock(editor: unknown, block: Record<string, unknown>) {
  insertOrUpdateBlockForSlashMenu(editor as UnsafeEditor, block as UnsafeBlock);
}

function insertInlineContent(editor: unknown, content: unknown[]) {
  (editor as UnsafeInlineContentEditor).insertInlineContent(content, {
    updateSelection: true,
  });
}

type SuggestionMenuEditor = {
  getExtension: (extension: typeof SuggestionMenu) =>
    | {
        openSuggestionMenu: (
          triggerCharacter: string,
          options?: {
            deleteTriggerCharacter?: boolean;
            ignoreQueryLength?: boolean;
            ensureLeadingSpace?: boolean;
          },
        ) => void;
      }
    | undefined;
};

/** Replaces the selected slash command with the normal visible @ mention flow. */
export function startNfmMentionAtCursor(editor: unknown) {
  (editor as SuggestionMenuEditor).getExtension(SuggestionMenu)?.openSuggestionMenu("@", {
    // BlockNote inserts and tracks the visible trigger when this is true,
    // then removes the complete @query range only after an item is chosen.
    deleteTriggerCharacter: true,
    ignoreQueryLength: true,
    ensureLeadingSpace: true,
  });
}

type CanvasSlashEditor = UnsafeEditor & {
  getTextCursorPosition: () => {
    readonly block?: {
      readonly id?: string;
      readonly type?: string;
    };
  };
};

interface PageReferenceInsertionBookmark {
  readonly blockId: string;
}

type PageReferenceBookmarkEditor = {
  getBlock: (blockId: string) => unknown;
  getTextCursorPosition: () => { readonly block?: { readonly id?: string } };
};

export function isPageReferenceInsertionBookmarkValid(
  editor: unknown,
  bookmark: PageReferenceInsertionBookmark | null,
): boolean {
  if (!bookmark) return false;
  const typedEditor = editor as PageReferenceBookmarkEditor;
  return Boolean(
    typedEditor.getBlock(bookmark.blockId) &&
    typedEditor.getTextCursorPosition().block?.id === bookmark.blockId,
  );
}

export function prepareCanvasCreateParagraph(editor: unknown): string {
  insertOrUpdateBlockForSlashMenu(editor as UnsafeEditor, { type: "paragraph" } as UnsafeBlock);
  const block = (editor as CanvasSlashEditor).getTextCursorPosition().block;
  if (!block?.id || block.type !== "paragraph") {
    throw new Error(
      getIntl().formatMessage({
        id: "editor.nfmSlashMenu.chooseEmptyParagraph",
        defaultMessage: "Choose an empty paragraph to create a Canvas.",
      }),
    );
  }
  return block.id;
}

function createDefaultNfmTableBlock() {
  return {
    type: "table",
    content: {
      type: "tableContent",
      columnWidths: [undefined, undefined],
      rows: Array.from({ length: 3 }, () => ({
        cells: Array.from({ length: 2 }, () => ({
          type: "tableCell",
          props: {
            backgroundColor: "default",
            textColor: "default",
            textAlignment: "left",
          },
          content: [],
        })),
      })),
    },
    children: [],
  };
}

function normalizeSuggestionAliasHint(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/") || trimmed.startsWith("@") || trimmed.startsWith(":")) return trimmed;
  if (trimmed.includes(" ")) return null;
  return `/${trimmed}`;
}

export function scrollElementIntoContainerView(container: HTMLElement, element: HTMLElement) {
  const containerHeight = container.clientHeight;
  if (containerHeight <= 0) return;

  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const elementTop = elementRect.top - containerRect.top + container.scrollTop;
  const rectHeight = elementRect.height || elementRect.bottom - elementRect.top;
  const elementHeight = Math.max(rectHeight || element.offsetHeight, 0);
  const elementBottom = elementTop + elementHeight;
  const visibleTop = container.scrollTop;
  const visibleBottom = visibleTop + containerHeight;

  if (elementHeight >= containerHeight) {
    if (elementTop < visibleTop || elementTop > visibleBottom) {
      container.scrollTop = elementTop;
    }
    return;
  }

  if (elementTop < visibleTop) {
    container.scrollTop = elementTop;
    return;
  }

  if (elementBottom > visibleBottom) {
    container.scrollTop = elementBottom - containerHeight;
  }
}

export function resolveNfmSuggestionHint(item: DefaultReactSuggestionItem) {
  const nfmItem = item as NfmSuggestionItem;
  if (nfmItem.hint !== undefined) {
    const explicitHint = nfmItem.hint?.trim();
    return explicitHint || null;
  }

  const key = nfmItem.key;
  if (key) {
    const syntaxHint = SUGGESTION_SYNTAX_HINT_BY_KEY[key];
    if (syntaxHint) return syntaxHint;
  }

  if (item.badge?.trim()) return item.badge.trim();

  const aliasHint = item.aliases
    ?.map(normalizeSuggestionAliasHint)
    .find((value): value is string => value !== null);
  if (aliasHint) return aliasHint;

  return null;
}

function resolveSuggestionTooltipContent(item: DefaultReactSuggestionItem) {
  const tooltipContent = (item as NfmSuggestionItem).tooltipContent;
  if (tooltipContent !== undefined) return tooltipContent;

  if (!item.subtext) return null;

  return <div className="max-w-64 text-sm leading-5 text-token-foreground">{item.subtext}</div>;
}

function renderSuggestionSegments(
  segments: readonly CommandPaletteHighlightSegment[] | null | undefined,
  fallback: string,
  keyPrefix: string,
) {
  if (!segments) return fallback;
  return segments.map((segment, index) => (
    <span
      key={`${keyPrefix}:${index}`}
      className={segment.highlight ? "font-medium text-token-foreground" : undefined}
    >
      {segment.text}
    </span>
  ));
}

export function NfmSuggestionMenuSurface({
  items,
  loadingState,
  itemsStale = false,
  selectedIndex,
  onItemClick,
  emptyMessage,
}: SuggestionMenuProps<DefaultReactSuggestionItem> & {
  readonly emptyMessage?: string;
}) {
  const intl = useIntl();
  const loading = loadingState === "loading-initial" || loadingState === "loading";
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (selectedIndex === undefined) return;

    const list = listRef.current;
    if (!list) return;

    const item = list.querySelector<HTMLElement>(`#bn-suggestion-menu-item-${selectedIndex}`);
    if (!item) return;

    scrollElementIntoContainerView(list, item);
  }, [selectedIndex]);

  const renderedItems = useMemo(() => {
    let currentGroup: string | undefined;
    const nodes: ReactNode[] = [];

    for (const [index, item] of items.entries()) {
      const suggestionItem = item as NfmSuggestionItem;
      const dateGroup = intl.locale === "en-US" ? undefined : suggestionItem.dateMentionGroup;
      const group = dateGroup ?? item.group?.trim();

      if (group && group !== currentGroup) {
        currentGroup = group;
        nodes.push(
          <NodexDropdownSectionLabel
            key={`group:${group}:${index}`}
            className="pb-0.5 pt-1.5 text-xs leading-4 text-token-description-foreground"
          >
            {dateGroup ? intl.formatMessage(DATE_MENTION_LABEL_MESSAGES[dateGroup]) : group}
          </NodexDropdownSectionLabel>,
        );
      }

      const selected = selectedIndex === index;
      const disabled = Boolean(suggestionItem.disabled);
      const detail = suggestionItem.detail?.trim();
      const hint = resolveNfmSuggestionHint(item);
      const row = (
        <NodexDropdownActionRow
          id={`bn-suggestion-menu-item-${index}`}
          role="option"
          aria-selected={selected}
          aria-disabled={disabled || undefined}
          data-mention-kind={
            suggestionItem.mentionRank?.family ?? suggestionItem.mentionUtility?.family
          }
          data-mention-utility={suggestionItem.mentionUtility?.kind}
          data-selected={selected || undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (!disabled) onItemClick?.(item);
          }}
          className={cn(
            "group min-h-7 items-center gap-2 px-2 py-1 text-left text-token-foreground",
            "data-[selected=true]:bg-token-list-hover-background",
            disabled && "cursor-default opacity-45",
          )}
        >
          {item.icon ? (
            <span className="flex size-5 shrink-0 items-center justify-center text-token-description-foreground">
              {item.icon}
            </span>
          ) : null}
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                "block truncate text-sm leading-4",
                suggestionItem.mentionUtility
                  ? "text-token-text-secondary group-hover:text-token-foreground group-focus-visible:text-token-foreground"
                  : "text-token-foreground",
                selected && "text-token-foreground",
              )}
            >
              {renderSuggestionSegments(suggestionItem.titleSegments, item.title, `${index}:title`)}
            </span>
            {detail ? (
              <span className="block truncate text-xs leading-4 text-token-description-foreground">
                {renderSuggestionSegments(suggestionItem.detailSegments, detail, `${index}:detail`)}
              </span>
            ) : null}
          </span>
          {hint ? (
            <span
              aria-label={intl.formatMessage(
                { id: "editor.nfmSlashMenu.shortcut", defaultMessage: "Shortcut {hint}" },
                { hint },
              )}
              className="ml-2 shrink-0 rounded-sm px-1 text-xs leading-4 text-token-description-foreground"
            >
              {hint}
            </span>
          ) : null}
        </NodexDropdownActionRow>
      );
      const tooltipContent = resolveSuggestionTooltipContent(item);

      nodes.push(
        <NodexTooltip
          key={suggestionItem.key ?? `${item.title}:${index}`}
          tooltipContent={tooltipContent}
          disabled={!tooltipContent}
          side="right"
          align="start"
          sideOffset={6}
          tooltipBodyClassName="min-w-0"
          style={{ zIndex: NFM_SUGGESTION_MENU_TOOLTIP_Z_INDEX }}
        >
          {row}
        </NodexTooltip>,
      );
    }
    return nodes;
  }, [intl, items, onItemClick, selectedIndex]);

  return (
    <NodexDropdownSurface
      id="bn-suggestion-menu"
      role="listbox"
      aria-busy={loading || itemsStale}
      className="w-[min(17.5rem,calc(100vw-16px))] overflow-hidden"
    >
      <NodexDropdownScrollList
        ref={listRef}
        data-nfm-suggestion-menu-scroll-list="true"
        className="scrollbar-token max-h-[min(18rem,calc(100vh-24px))] gap-0.5"
      >
        {renderedItems}
        {items.length === 0 ? (
          <NodexDropdownMessage compact centered>
            {loading
              ? intl.formatMessage({
                  id: "editor.nfmSlashMenu.loading",
                  defaultMessage: "Loading...",
                })
              : (emptyMessage ??
                intl.formatMessage({
                  id: "editor.nfmSlashMenu.noCommands",
                  defaultMessage: "No matching commands",
                }))}
          </NodexDropdownMessage>
        ) : itemsStale ? (
          <NodexDropdownMessage compact centered>
            {intl.formatMessage({
              id: "editor.nfmSlashMenu.updating",
              defaultMessage: "Updating...",
            })}
          </NodexDropdownMessage>
        ) : null}
      </NodexDropdownScrollList>
    </NodexDropdownSurface>
  );
}

function NfmMentionSuggestionMenuSurface(props: SuggestionMenuProps<DefaultReactSuggestionItem>) {
  const intl = useIntl();
  return (
    <NfmSuggestionMenuSurface
      {...props}
      emptyMessage={intl.formatMessage({
        id: "editor.nfmSlashMenu.noMentions",
        defaultMessage: "No matching mentions",
      })}
    />
  );
}

function NfmPageSuggestionMenuSurface(props: SuggestionMenuProps<DefaultReactSuggestionItem>) {
  const intl = useIntl();
  return (
    <NfmSuggestionMenuSurface
      {...props}
      emptyMessage={intl.formatMessage({
        id: "editor.nfmSlashMenu.noPages",
        defaultMessage: "No matching Pages",
      })}
    />
  );
}

interface NfmSlashMenuCustomItemActions {
  readonly createCanvasAtEmptyParagraph?: (input: {
    readonly blockId: string;
    readonly displayName?: string;
  }) => Promise<{ readonly canvasBlockId: string }>;
  readonly startMentionFlow?: () => void;
  readonly openEmbedPagePicker?: () => void;
  readonly openSubpageCreator?: () => void;
}

export function getNfmSlashMenuCustomItems(
  editor: unknown,
  {
    createCanvasAtEmptyParagraph,
    startMentionFlow,
    openEmbedPagePicker,
    openSubpageCreator,
  }: NfmSlashMenuCustomItemActions = {},
  intl = getIntl(),
): NfmSuggestionItem[] {
  const schema = (
    editor as {
      readonly schema?: { readonly blockSchema?: unknown; readonly inlineContentSchema?: unknown };
    }
  ).schema;
  const [mathBlockItem, inlineMathItem] =
    schema?.blockSchema && schema.inlineContentSchema
      ? getMathSlashMenuItems(editor as Parameters<typeof getMathSlashMenuItems>[0])
      : [];
  const calloutItem = {
    key: "callout",
    title: intl.formatMessage({ id: "editor.nfmSlashMenu.callout", defaultMessage: "Callout" }),
    subtext: intl.formatMessage({
      id: "editor.nfmSlashMenu.calloutDetail",
      defaultMessage: "Highlight important information",
    }),
    aliases: ["callout", "aside", "notice"],
    hint: null,
    onItemClick: () => {
      insertBlock(editor, { type: "callout" });
    },
  } satisfies NfmSuggestionItem;

  const promptItem = {
    key: "prompt",
    title: intl.formatMessage({ id: "editor.nfmSlashMenu.prompt", defaultMessage: "Prompt" }),
    subtext: intl.formatMessage({
      id: "editor.nfmSlashMenu.promptDetail",
      defaultMessage: "Write something to send to a chat",
    }),
    aliases: ["prompt", "ask", "send", "chat", "agent", "task"],
    hint: null,
    onItemClick: () => {
      insertBlock(editor, { type: "prompt" });
    },
  } satisfies NfmSuggestionItem;

  const codeItem = {
    key: "code_block",
    title: intl.formatMessage({ id: "editor.nfmSlashMenu.code", defaultMessage: "Code" }),
    subtext: intl.formatMessage({
      id: "editor.nfmSlashMenu.codeDetail",
      defaultMessage: "Capture code with syntax highlighting",
    }),
    aliases: ["code", "snippet", "source"],
    hint: null,
    onItemClick: () => {
      insertBlock(editor, {
        type: "codeBlock",
        props: { language: codeLanguagePreference.get() },
      });
    },
  } satisfies NfmSuggestionItem;

  const mermaidCodeItem = {
    key: "code_mermaid",
    title: intl.formatMessage(slashTitles.mermaid),
    subtext: intl.formatMessage({
      id: "editor.nfmSlashMenu.mermaidDetail",
      defaultMessage: "Create an editable Mermaid diagram",
    }),
    aliases: ["mermaid", "diagram", "flowchart", "graph"],
    hint: null,
    onItemClick: () => {
      insertBlock(editor, {
        type: "codeBlock",
        props: { language: "mermaid" },
        content: "graph TD\n  Mermaid --> Diagram\n",
      });
    },
  } satisfies NfmSuggestionItem;

  const tableItem = {
    key: "table",
    title: intl.formatMessage(slashTitles.table),
    subtext: intl.formatMessage({
      id: "editor.nfmSlashMenu.tableDetail",
      defaultMessage: "Insert a simple editable table",
    }),
    aliases: ["table", "grid"],
    hint: null,
    onItemClick: () => {
      insertBlock(editor, createDefaultNfmTableBlock());
    },
  } satisfies NfmSuggestionItem;

  const agentConfigItem = {
    key: "agent_config",
    title: intl.formatMessage(slashTitles.agentConfig),
    subtext: intl.formatMessage({
      id: "editor.nfmSlashMenu.configDetail",
      defaultMessage: "Insert a one-send plan-mode config chip",
    }),
    aliases: ["agent-config", "agent config", "plan", "plan mode", "mode", "model", "reasoning"],
    hint: null,
    onItemClick: () => {
      insertInlineContent(editor, [
        {
          type: "agentConfig",
          props: {
            mode: "plan",
            model: "",
            reasoning: "",
            unknownAttributes: "",
            rawAttributes: "",
          },
        },
        " ",
      ]);
    },
  } satisfies NfmSuggestionItem;

  const canvasItem = createCanvasAtEmptyParagraph
    ? {
        key: "canvas",
        title: intl.formatMessage(slashTitles.canvas),
        subtext: intl.formatMessage({
          id: "editor.nfmSlashMenu.canvasDetail",
          defaultMessage: "Create an independent Canvas in this Page",
        }),
        aliases: ["canvas", "whiteboard", "drawing"],
        hint: null,
        onItemClick: () => {
          void (async () => {
            let blockId: string | null = null;
            try {
              blockId = prepareCanvasCreateParagraph(editor);
              setCanvasCreatePending(
                editor as Parameters<typeof setCanvasCreatePending>[0],
                blockId,
                true,
              );
              await createCanvasAtEmptyParagraph({ blockId });
            } catch (error) {
              if (blockId) {
                setCanvasCreatePending(
                  editor as Parameters<typeof setCanvasCreatePending>[0],
                  blockId,
                  false,
                );
              }
              toast.danger(
                error instanceof Error
                  ? error.message
                  : getIntl().formatMessage({
                      id: "editor.nfmSlashMenu.canvasCreateFailed",
                      defaultMessage: "Could not create Canvas",
                    }),
              );
            }
          })();
        },
      }
    : null;

  const embedPageItem = openEmbedPagePicker
    ? {
        key: "embed_page",
        title: intl.formatMessage(slashTitles.embedPage),
        subtext: intl.formatMessage({
          id: "editor.nfmSlashMenu.embedPageDetail",
          defaultMessage: "Show a live reference to another Page",
        }),
        aliases: ["embed", "page", "reference", "page reference"],
        hint: null,
        onItemClick: openEmbedPagePicker,
      }
    : null;

  const mentionPageItem = startMentionFlow
    ? {
        key: "mention_page",
        title: intl.formatMessage(slashTitles.mentionPage),
        subtext: intl.formatMessage({
          id: "editor.nfmSlashMenu.mentionPageDetail",
          defaultMessage: "Mention another Page inline",
        }),
        aliases: ["mention", "mention page", "page mention", "page", "@"],
        hint: null,
        onItemClick: startMentionFlow,
      }
    : null;

  const subpageItem = openSubpageCreator
    ? {
        key: "subpage",
        title: intl.formatMessage(slashTitles.subpage),
        subtext: intl.formatMessage({
          id: "editor.nfmSlashMenu.subpageDetail",
          defaultMessage: "Create a Page owned by this Page",
        }),
        aliases: ["subpage", "child page", "nested page"],
        hint: null,
        onItemClick: openSubpageCreator,
      }
    : null;

  const items = [
    ...(inlineMathItem
      ? [
          {
            ...inlineMathItem,
            key: "inline_math",
            title: intl.formatMessage(slashTitles.inlineEquation),
            subtext: intl.formatMessage({
              id: "editor.nfmSlashMenu.inlineEquationDetail",
              defaultMessage: "Insert a formula in the current line",
            }),
            aliases: ["inline equation", "inline math", "formula", "latex"],
            hint: null,
          } satisfies NfmSuggestionItem,
        ]
      : []),
    calloutItem,
    promptItem,
    codeItem,
    mermaidCodeItem,
    ...(mathBlockItem
      ? [
          {
            ...mathBlockItem,
            key: "math_block",
            title: intl.formatMessage(slashTitles.blockEquation),
            subtext: intl.formatMessage({
              id: "editor.nfmSlashMenu.blockEquationDetail",
              defaultMessage: "Display a standalone mathematical formula",
            }),
            aliases: ["equation", "math", "formula", "latex"],
            hint: null,
          } satisfies NfmSuggestionItem,
        ]
      : []),
    tableItem,
    ...(canvasItem ? [canvasItem] : []),
    ...(mentionPageItem ? [mentionPageItem] : []),
    ...(embedPageItem ? [embedPageItem] : []),
    ...(subpageItem ? [subpageItem] : []),
    agentConfigItem,
  ];

  return items.flatMap((item) => {
    const presentedItem = presentNfmSlashMenuItem(item, intl);
    return presentedItem ? [presentedItem] : [];
  });
}

export function NfmSlashMenu({
  catalogRef,
  executionProjectId,
  allowPageReferences = true,
  locale: localeProp,
}: NfmSlashMenuProps) {
  const intl = useIntl();
  const editor = useBlockNoteEditor();
  const locale = useMemo(() => localeProp ?? getBrowserLocale(), [localeProp]);
  const hostRuntime = useBlockReferenceHostRuntime();
  const typedSuggestionControllers = useMemo(
    () =>
      createNfmTypedSuggestionControllerConfig(
        locale,
        {
          canCreatePageMention: Boolean(hostRuntime?.createPageMention),
        },
        intl,
      ),
    [hostRuntime?.createPageMention, intl, locale],
  );
  const embedPageBookmarkRef = useRef<PageReferenceInsertionBookmark | null>(null);
  const startMentionFlow = useCallback(() => {
    startNfmMentionAtCursor(editor);
  }, [editor]);
  const openEmbedPagePicker = useCallback(() => {
    const blockId = (editor as unknown as CanvasSlashEditor).getTextCursorPosition().block?.id;
    if (!blockId) {
      toast.danger(
        getIntl().formatMessage({
          id: "editor.nfmSlashMenu.preserveInsertionPointFailed",
          defaultMessage: "Could not preserve the Page reference insertion point.",
        }),
      );
      return;
    }
    embedPageBookmarkRef.current = { blockId };
    editor.getExtension(SuggestionMenu)?.openSuggestionMenu(PAGE_EMBED_PICKER_TRIGGER, {
      ignoreQueryLength: true,
    });
  }, [editor]);
  const openSubpageCreator = useCallback(() => {
    editor.getExtension(SuggestionMenu)?.openSuggestionMenu(SUBPAGE_NAME_TRIGGER, {
      ignoreQueryLength: true,
    });
  }, [editor]);

  const readCatalog = useMemo(
    () =>
      (intl = getIntl()) =>
        buildNfmSlashMenuItems(
          localizeDefaultSlashItems(getDefaultReactSlashMenuItems(editor), intl.locale),
          getNfmSlashMenuCustomItems(
            editor,
            {
              createCanvasAtEmptyParagraph: hostRuntime?.createCanvasAtEmptyParagraph,
              startMentionFlow: allowPageReferences ? startMentionFlow : undefined,
              openEmbedPagePicker: allowPageReferences ? openEmbedPagePicker : undefined,
              openSubpageCreator: hostRuntime?.createSubpageAtEmptyParagraph
                ? openSubpageCreator
                : undefined,
            },
            intl,
          ),
          intl,
        ),
    [
      allowPageReferences,
      editor,
      hostRuntime?.createCanvasAtEmptyParagraph,
      hostRuntime?.createSubpageAtEmptyParagraph,
      openEmbedPagePicker,
      openSubpageCreator,
      startMentionFlow,
    ],
  );
  const getItems = useMemo(
    () => async (query: string) => filterSuggestionItems(readCatalog(intl), query),
    [intl, readCatalog],
  );
  useLayoutEffect(() => {
    if (!catalogRef) return;
    catalogRef.current = readCatalog;
    return () => {
      if (catalogRef.current === readCatalog) catalogRef.current = null;
    };
  }, [catalogRef, readCatalog]);

  return (
    <NodexFloatingLayerProvider zIndex={NFM_SUGGESTION_MENU_Z_INDEX}>
      {typedSuggestionControllers.slash.map(({ triggerCharacter, shouldOpen, temporaryInput }) => (
        <SuggestionMenuController
          key={triggerCharacter}
          triggerCharacter={triggerCharacter}
          getItems={getItems}
          requestScopeKey={intl.locale}
          shouldOpen={shouldOpen}
          shouldCloseOnQuery={shouldCloseNfmSlashQuery}
          temporaryInput={temporaryInput}
          {...NFM_SUGGESTION_MENU_CONTROLLER_PORTAL_PROPS}
          suggestionMenuComponent={NfmSuggestionMenuSurface}
        />
      ))}
      {typedSuggestionControllers.pageMention.map((controller) => (
        <MentionMenu
          key={controller.triggerCharacter}
          activeProjectId={executionProjectId}
          allowPageReferences={allowPageReferences}
          controller={controller}
        />
      ))}
      <SkillMentionMenu controller={typedSuggestionControllers.skillMention} />
      <GridSuggestionMenuController
        triggerCharacter={typedSuggestionControllers.emoji.triggerCharacter}
        columns={typedSuggestionControllers.emoji.columns}
        minQueryLength={typedSuggestionControllers.emoji.minQueryLength}
        shouldOpen={typedSuggestionControllers.emoji.shouldOpen}
        {...NFM_SUGGESTION_MENU_CONTROLLER_PORTAL_PROPS}
      />
      {allowPageReferences ? <EmbedPageMenu bookmarkRef={embedPageBookmarkRef} /> : null}
      {hostRuntime?.createSubpageAtEmptyParagraph ? <SubpageMenu /> : null}
    </NodexFloatingLayerProvider>
  );
}

function SubpageMenu() {
  const intl = useIntl();
  const editor = useBlockNoteEditor();
  const hostRuntime = useBlockReferenceHostRuntime();
  const getItems = useCallback(
    async (query: string): Promise<NfmSuggestionItem[]> => {
      const title = query.trim() || "Untitled";
      return [
        {
          key: "create_subpage",
          title:
            query.trim() ||
            getIntl().formatMessage({
              id: "editor.nfmSlashMenu.untitled",
              defaultMessage: "Untitled",
            }),
          subtext: getIntl().formatMessage({
            id: "editor.nfmSlashMenu.createSubpage",
            defaultMessage: "Create Subpage",
          }),
          aliases: [],
          group: getIntl().formatMessage({
            id: "editor.nfmSlashMenu.subpageName",
            defaultMessage: "Subpage name",
          }),
          hint: "Enter",
          icon: <PageIcon className="size-4" aria-hidden="true" />,
          onItemClick: () => {
            void (async () => {
              return await runWithCleanup(
                async () => {
                  const blockId = prepareCanvasCreateParagraph(editor);
                  await hostRuntime?.createSubpageAtEmptyParagraph?.({ blockId, title });
                },
                {
                  onError: async (error: unknown) => {
                    toast.danger(
                      error instanceof Error
                        ? error.message
                        : getIntl().formatMessage({
                            id: "editor.nfmSlashMenu.subpageCreateFailed",
                            defaultMessage: "Could not create Subpage",
                          }),
                    );
                  },
                },
              );
            })();
          },
        } satisfies NfmSuggestionItem,
      ];
    },
    [editor, hostRuntime],
  );
  return (
    <SuggestionMenuController
      triggerCharacter={SUBPAGE_NAME_TRIGGER}
      getItems={getItems}
      requestScopeKey={intl.locale}
      {...NFM_SUGGESTION_MENU_CONTROLLER_PORTAL_PROPS}
      suggestionMenuComponent={NfmSuggestionMenuSurface}
    />
  );
}

// ---------------------------------------------------------------------------
// @ mention for pages and chats
// ---------------------------------------------------------------------------

const CHAT_MENTION_LIMIT = 24;

type ThreadMentionSubtextInput = Pick<
  ChatCatalogEntry,
  "threadId" | "projectId" | "projectName" | "activity"
>;

type ThreadMentionMatch = ChatSearchMatch & { readonly inActiveProject: boolean };

function buildMentionTooltipContent(
  title: string,
  lines: readonly (string | null | undefined)[],
): ReactNode {
  const normalizedLines = Array.from(
    new Set(
      lines
        .map((line) => line?.replace(/\s+/g, " ").trim() ?? "")
        .filter((line) => line && line !== title),
    ),
  );
  return (
    <div className="max-w-80 space-y-1 text-sm leading-5">
      <div className="text-token-foreground">{title}</div>
      {normalizedLines.map((line) => (
        <div key={line} className="wrap-break-word text-token-description-foreground">
          {line}
        </div>
      ))}
    </div>
  );
}

function resolveThreadMentionTitle(chat: ChatCatalogEntry): string {
  if (chat.title.trim()) return chat.title;
  return formatThreadMentionShortUuid(chat.threadId ?? chat.sessionId);
}

function resolveThreadMentionStateLabel(chat: Pick<ChatCatalogEntry, "activity">): string {
  switch (chat.activity) {
    case "error":
      return getIntl().formatMessage({ id: "editor.nfmSlashMenu.error", defaultMessage: "Error" });
    case "waitingOnApproval":
      return getIntl().formatMessage({
        id: "editor.nfmSlashMenu.needsApproval",
        defaultMessage: "Needs approval",
      });
    case "waitingOnUserInput":
      return getIntl().formatMessage({
        id: "editor.nfmSlashMenu.waiting",
        defaultMessage: "Waiting",
      });
    case "running":
      return getIntl().formatMessage({
        id: "editor.nfmSlashMenu.running",
        defaultMessage: "Running",
      });
    case "idle":
      return "";
  }
}

export function resolveThreadMentionSubtext(
  chat: ThreadMentionSubtextInput,
  project: Pick<Project, "id" | "name"> | null,
): string {
  const projectLabel =
    project?.name?.trim() ||
    project?.id ||
    chat.projectName?.trim() ||
    chat.projectId ||
    getIntl().formatMessage({ id: "editor.nfmSlashMenu.chats", defaultMessage: "Chats" });
  const stateLabel = resolveThreadMentionStateLabel(chat);
  return [projectLabel, stateLabel, chat.threadId && formatThreadMentionShortUuid(chat.threadId)]
    .filter(Boolean)
    .join(" / ");
}

function resolveThreadMentionContext(chat: ChatCatalogEntry): string {
  const projectLabel =
    chat.projectName?.trim() ||
    (chat.projectId
      ? getIntl().formatMessage({ id: "editor.nfmSlashMenu.chats", defaultMessage: "Chats" })
      : getIntl().formatMessage({
          id: "editor.nfmSlashMenu.projectlessChat",
          defaultMessage: "Projectless chat",
        }));
  const stateLabel = resolveThreadMentionStateLabel(chat);
  return [projectLabel, stateLabel].filter(Boolean).join(" / ");
}

export function buildNfmThreadMentionInlineContent(
  chat: Pick<ChatCatalogEntry, "threadId" | "sessionId">,
): unknown[] {
  if (chat.threadId === null) return [];
  return [
    {
      type: "threadMention",
      props: { uuid: chat.sessionId },
    },
    " ",
  ];
}

export function buildDateMentionInlineContent(payload: DateMentionInlineContent): unknown[] {
  return [
    {
      type: "dateMention",
      props: dateMentionPayloadToProps(payload),
    },
    " ",
  ];
}

export function buildDateMentionSuggestionItem(
  editor: unknown,
  match: DateMentionQueryMatch,
  sourceOrder = 0,
): NfmSuggestionItem {
  const isReminder = match.group === "Reminders";
  const Icon = isReminder ? BellIcon : match.key === "date:now" ? ClockIcon : CalendarIcon;
  return {
    key: match.key,
    title: match.title,
    subtext: match.subtext,
    aliases: match.aliases,
    group: getIntl().formatMessage({ id: "editor.nfmSlashMenu.dateGroup", defaultMessage: "Date" }),
    dateMentionGroup: match.group,
    hint: match.aliases[0] ? `@${match.aliases[0]}` : "@date",
    tooltipContent: buildMentionTooltipContent(match.title, [match.subtext]),
    mentionRank: {
      family: "temporal",
      match: "temporal_intent",
      activeContext: true,
      sourceOrder,
    },
    icon: <Icon className="size-4" aria-hidden="true" />,
    onItemClick: () => {
      insertInlineContent(editor, buildDateMentionInlineContent(match.payload));
    },
  };
}

export function buildDateMentionSuggestionItems(
  editor: unknown,
  query: string,
  now = new Date(),
  intl = getIntl(),
): NfmSuggestionItem[] {
  return buildLocalizedDateMentionQueryMatches(query, intl, now).map((match, index) =>
    buildDateMentionSuggestionItem(editor, match, index),
  );
}

export function buildPageReferenceCandidateSuggestionItems(
  editor: unknown,
  candidates: readonly PageReferenceCandidate[],
  intent: PageReferenceIntent,
  beforeSelect?: () => boolean,
): NfmSuggestionItem[] {
  return presentPageReferenceCandidates(candidates).map(
    ({ candidate, detail, detailSegments, match, titleSegments }, sourceOrder) => {
      const disabledLabel =
        candidate.disabledReason === "self"
          ? getIntl().formatMessage({
              id: "editor.nfmSlashMenu.embedSelf",
              defaultMessage: "Current Page cannot be embedded",
            })
          : candidate.disabledReason === "ancestor_cycle"
            ? getIntl().formatMessage({
                id: "editor.nfmSlashMenu.embedAncestor",
                defaultMessage: "An ancestor Page cannot be embedded",
              })
            : null;
      const statusLabel = candidate.status?.label ?? null;
      const metadata = [candidate.pageKey, statusLabel, candidate.locationLabel]
        .filter(Boolean)
        .join(" · ");
      const fullExcerpt = match === "content" ? candidate.matchExcerpt : null;
      return {
        title:
          candidate.title ||
          getIntl().formatMessage({
            id: "editor.nfmSlashMenu.untitled",
            defaultMessage: "Untitled",
          }),
        subtext: disabledLabel ?? detail ?? undefined,
        detail: disabledLabel ?? detail,
        titleSegments,
        detailSegments: disabledLabel ? null : detailSegments,
        aliases: [],
        key: `page:${candidate.pageId}`,
        group: getIntl().formatMessage(
          intent === "mention" ? slashTitles.mentionPage : slashGroups.pages,
        ),
        hint: null,
        disabled: Boolean(candidate.disabledReason),
        tooltipContent: buildMentionTooltipContent(
          candidate.title ||
            getIntl().formatMessage({
              id: "editor.nfmSlashMenu.untitled",
              defaultMessage: "Untitled",
            }),
          [disabledLabel, metadata, fullExcerpt],
        ),
        mentionRank:
          intent === "mention"
            ? {
                family: "page",
                match,
                activeContext: true,
                sourceOrder,
              }
            : undefined,
        icon: candidate.status ? (
          <StatusIcon statusId={candidate.status?.optionId} className="size-4" />
        ) : (
          <PageIcon className="icon-xs shrink-0" aria-hidden="true" />
        ),
        onItemClick: () => {
          if (candidate.disabledReason) return;
          if (beforeSelect && !beforeSelect()) return;
          if (intent === "reference_block") {
            insertBlock(editor, {
              type: "pageRef",
              props: { targetBlockId: candidate.pageId },
            });
            return;
          }
          insertInlineContent(editor, [
            { type: "pageMention", props: { targetPageId: candidate.pageId } },
            " ",
          ]);
        },
      } satisfies NfmSuggestionItem;
    },
  );
}

export function buildPageSearchUnavailableSuggestionItem(
  intent: PageReferenceIntent,
): NfmSuggestionItem {
  return {
    key: "page-search-unavailable",
    title: getIntl().formatMessage({
      id: "editor.nfmSlashMenu.pagesUnavailable",
      defaultMessage: "Pages unavailable",
    }),
    subtext: getIntl().formatMessage({
      id: "editor.nfmSlashMenu.pageSearchUnavailable",
      defaultMessage: "Page search is unavailable. Try again.",
    }),
    group: getIntl().formatMessage(
      intent === "mention" ? slashTitles.mentionPage : slashGroups.pages,
    ),
    icon: <PageIcon className="size-4" />,
    disabled: true,
    mentionRank: {
      family: "page",
      match: "recent",
      activeContext: false,
      sourceOrder: 0,
    },
    onItemClick: () => {},
  };
}

function usePageReferenceGetItems(intent: PageReferenceIntent, beforeSelect?: () => boolean) {
  const { locale } = useIntl();
  const editor = useBlockNoteEditor();
  const hostRuntime = useBlockReferenceHostRuntime();
  const controllerRef = useRef(createPageReferenceSearchController());
  // A host wrapper may gain a fresh object identity while the menu is open.
  // Keep the loader identity stable so a pointer gesture cannot lose its row
  // between mousedown and click when async enrichment finishes.
  const editorRef = useRef(editor);
  const hostRuntimeRef = useRef(hostRuntime);
  const beforeSelectRef = useRef(beforeSelect);
  const requestScopeKey = hostRuntime
    ? JSON.stringify([
        locale,
        contentRoutingContextKey(hostRuntime.contentRoutingContext),
        hostRuntime.hostPageId,
        ...hostRuntime.ancestorPageIds,
      ])
    : `${locale}:no-page-context`;
  useLayoutEffect(() => {
    editorRef.current = editor;
    hostRuntimeRef.current = hostRuntime;
    beforeSelectRef.current = beforeSelect;
  }, [beforeSelect, editor, hostRuntime]);
  const getItems = useCallback(
    async (query: string) => {
      const currentHostRuntime = hostRuntimeRef.current;
      if (!currentHostRuntime) return [];
      try {
        const result = await controllerRef.current.search({
          routingContext: currentHostRuntime.contentRoutingContext,
          hostPageId: currentHostRuntime.hostPageId,
          ancestorPageIds: currentHostRuntime.ancestorPageIds,
          intent,
          query,
          limit: 24,
        });
        if (result.status === "stale") return [];
        return buildPageReferenceCandidateSuggestionItems(
          editorRef.current,
          result.items,
          intent,
          beforeSelectRef.current,
        );
      } catch {
        return [buildPageSearchUnavailableSuggestionItem(intent)];
      }
    },
    [intent],
  );
  const getImmediateItems = useCallback(
    (query: string) => {
      const currentHostRuntime = hostRuntimeRef.current;
      if (!currentHostRuntime) return [];
      return buildPageReferenceCandidateSuggestionItems(
        editorRef.current,
        loadPageReferenceCandidatesSync({
          routingContext: currentHostRuntime.contentRoutingContext,
          hostPageId: currentHostRuntime.hostPageId,
          ancestorPageIds: currentHostRuntime.ancestorPageIds,
          intent,
          query,
          limit: 24,
        }),
        intent,
        beforeSelectRef.current,
      );
    },
    [intent],
  );
  return useMemo(
    () => ({ getItems, getImmediateItems, requestScopeKey }),
    [getImmediateItems, getItems, requestScopeKey],
  );
}

function classifyThreadMentionMatch(
  match: ChatSearchMatch,
  query: string,
): MentionSuggestionRank["match"] {
  if (match.excerpt) return "content";
  if (!query.trim()) return "recent";
  // Main ranks title and metadata matches together, ahead of message excerpts.
  // Keep that order instead of trying to match the query again in the renderer.
  return "title";
}

export function buildNfmThreadMentionSuggestionItems(
  editor: unknown,
  matches: readonly ThreadMentionMatch[],
  query: string,
): NfmSuggestionItem[] {
  const startedMatches = matches.filter(({ chat }) => chat.threadId !== null);
  const titleCounts = new Map<string, number>();
  for (const { chat } of startedMatches) {
    const title = resolveThreadMentionTitle(chat).trim().toLocaleLowerCase();
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }

  return startedMatches.map((match, sourceOrder) => {
    const { chat, excerpt, titleRanges, inActiveProject } = match;
    const title = resolveThreadMentionTitle(chat);
    const duplicateTitle = (titleCounts.get(title.trim().toLocaleLowerCase()) ?? 0) > 1;
    const context = resolveThreadMentionContext(chat);
    const detail = excerpt ? excerpt.text : duplicateTitle ? context : null;
    return {
      title,
      subtext: detail ?? undefined,
      detail,
      titleSegments: chatHighlightSegments(title, titleRanges),
      detailSegments: excerpt ? chatHighlightSegments(excerpt.text, excerpt.ranges) : null,
      aliases: [],
      group: getIntl().formatMessage({
        id: "editor.nfmSlashMenu.mentionChat",
        defaultMessage: "Mention a chat",
      }),
      hint: null,
      tooltipContent: buildMentionTooltipContent(title, [context, excerpt?.text]),
      mentionRank: {
        family: "chat",
        match: classifyThreadMentionMatch(match, query),
        activeContext: inActiveProject,
        sourceOrder,
      },
      icon: <ChatIcon className="size-4" />,
      onItemClick: () => {
        insertInlineContent(editor, buildNfmThreadMentionInlineContent(chat));
      },
    } satisfies NfmSuggestionItem;
  });
}

export function selectNfmMentionSuggestionItems(
  query: string,
  items: readonly NfmSuggestionItem[],
  options: {
    readonly expandedFamilies?: ReadonlySet<MentionSuggestionFamily>;
    readonly onExpandSection?: (family: MentionSuggestionFamily) => void;
  } = {},
): NfmSuggestionItem[] {
  return selectNfmPageMentionSuggestionItems(
    query,
    items,
    getNfmPageMentionEntryProfile("@"),
    [],
    options,
  );
}

export function selectNfmPageMentionSuggestionItems(
  query: string,
  items: readonly NfmSuggestionItem[],
  profile: NfmPageMentionEntryProfile,
  createItems: readonly NfmSuggestionItem[],
  options: {
    readonly expandedFamilies?: ReadonlySet<MentionSuggestionFamily>;
    readonly onExpandSection?: (family: MentionSuggestionFamily) => void;
  } = {},
): NfmSuggestionItem[] {
  const sections = selectNfmPageMentionSections({
    profile,
    query,
    rankedResults: items.flatMap((item) =>
      item.mentionRank ? [{ rank: item.mentionRank, value: item }] : [],
    ),
    createItems,
    expandedFamilies: options.expandedFamilies,
  });
  return sections.flatMap((section) => {
    const visibleItems = section.items.map((item) => ({
      ...item,
      group: section.label ?? item.group,
    }));
    if (section.hiddenItemCount === 0 || section.family === "create_page") {
      return visibleItems;
    }

    const overflowCount = section.hiddenItemCount;
    return [
      ...visibleItems,
      {
        key: `mention-expand:${section.family}`,
        title: getIntl().formatMessage(
          {
            id: "editor.nfmSlashMenu.moreResults",
            defaultMessage: "{count, plural, one {# more result} other {# more results}}",
          },
          { count: overflowCount },
        ),
        aliases: [],
        group: section.label,
        hint: null,
        tooltipContent: null,
        mentionUtility: {
          kind: "expand_section",
          family: section.family,
        },
        icon: <MoreActionsIcon className="icon-xs shrink-0" aria-hidden="true" />,
        onItemClick: () => options.onExpandSection?.(section.family),
      } satisfies NfmSuggestionItem,
    ];
  });
}

export function resolveNfmPageMentionCompletion(
  item: NfmSuggestionItem,
  query: string,
): string | null {
  if (!query) return null;
  if (!item.title.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) return null;
  return item.title.slice(query.length) || null;
}

export interface NfmMentionGetItemsLoaders {
  searchChats: typeof searchChats;
  searchChatMessages: typeof searchChatMessages;
}

interface NfmMentionGetItemsInput {
  editor: unknown;
  activeProjectId: string | null;
  loaders?: NfmMentionGetItemsLoaders;
}

const DEFAULT_NFM_MENTION_GET_ITEMS_LOADERS: NfmMentionGetItemsLoaders = {
  searchChats,
  searchChatMessages,
};

interface NfmMentionChatSearchRequest {
  readonly key: string;
  readonly catalog: Promise<readonly ChatSearchMatch[]>;
}

export function useNfmMentionGetItems({
  editor,
  activeProjectId,
  loaders = DEFAULT_NFM_MENTION_GET_ITEMS_LOADERS,
}: NfmMentionGetItemsInput): (query: string) => Promise<NfmSuggestionItem[]> {
  const intl = useIntl();
  const [asyncResults, setAsyncResults] = useState<{
    readonly request: NfmMentionChatSearchRequest;
    readonly matches: readonly ChatSearchMatch[];
  } | null>(null);
  const requestRef = useRef<NfmMentionChatSearchRequest | null>(null);
  const activeProjectIdRef = useRef(activeProjectId);
  const loadersRef = useRef(loaders);
  const editorRef = useRef(editor);

  useLayoutEffect(() => {
    activeProjectIdRef.current = activeProjectId;
    loadersRef.current = loaders;
    editorRef.current = editor;
  }, [activeProjectId, editor, loaders]);

  useLayoutEffect(
    () => () => {
      requestRef.current = null;
    },
    [],
  );

  const searchMessages = useCallback(
    (request: NfmMentionChatSearchRequest, query: string, activeProjectId: string | null) => {
      if (!searchesChatMessages(query)) return;
      void loadersRef.current
        .searchChatMessages({ query, limit: CHAT_MENTION_LIMIT })
        .then(({ matches }) => matches.filter(({ chat }) => chat.threadId !== null))
        .catch(() => [])
        .then((matches) => {
          if (requestRef.current !== request || activeProjectIdRef.current !== activeProjectId) {
            return;
          }
          startTransition(() => setAsyncResults({ request, matches }));
        });
    },
    [],
  );

  return useCallback(
    async (query: string) => {
      const queryText = query.trim();
      const activeProjectId = activeProjectIdRef.current;
      const requestKey = JSON.stringify([activeProjectId, queryText]);
      let request = requestRef.current;
      if (request?.key !== requestKey) {
        const currentLoaders = loadersRef.current;
        request = {
          key: requestKey,
          catalog: currentLoaders
            .searchChats({ query: queryText, limit: CHAT_MENTION_LIMIT, startedOnly: true })
            .then(({ matches }) => matches)
            .catch(() => []),
        };
        requestRef.current = request;
        searchMessages(request, queryText, activeProjectId);
      }

      const catalog = await request.catalog;
      if (requestRef.current !== request || activeProjectIdRef.current !== activeProjectId) {
        return [];
      }
      const messages = asyncResults?.request === request ? asyncResults.matches : [];
      const matches = preferChatProject(
        mergeChatSearchMatches(catalog, messages, CHAT_MENTION_LIMIT),
        activeProjectId,
      ).map((match) => ({
        ...match,
        inActiveProject: match.chat.projectId === activeProjectId,
      }));
      return [
        ...buildNfmThreadMentionSuggestionItems(editorRef.current, matches, queryText),
        ...buildDateMentionSuggestionItems(editorRef.current, queryText, undefined, intl),
      ];
    },
    [asyncResults, intl, searchMessages],
  );
}

const EMPTY_SKILLS: readonly PageSkillMention[] = [];

/** `@Nodex` turns the caret's block into a Prompt, so its own text is the message to send. */
export function buildNfmNodexAgentSuggestionItems(
  editor: unknown,
  query: string,
): NfmSuggestionItem[] {
  if (!matchesNodexAgentMention(query)) return [];
  return [
    {
      key: "agent:nodex",
      title: NODEX_AGENT_MENTION_TITLE,
      subtext: getIntl().formatMessage({
        id: "editor.nfmSlashMenu.nodexPrompt",
        defaultMessage: "Make this block a Prompt for Nodex",
      }),
      group: getIntl().formatMessage(slashGroups.agent),
      aliases: ["agent", "prompt"],
      hint: null,
      icon: <AskAiIcon className="size-4" />,
      onItemClick: () =>
        turnCaretBlockIntoPrompt(editor as Parameters<typeof turnCaretBlockIntoPrompt>[0]),
    },
  ];
}

export function buildNfmSkillMentionSuggestionItems(
  editor: unknown,
  skills: readonly PageSkillMention[],
  query: string,
  entry: "dollar" | "broad",
): NfmSuggestionItem[] {
  const term = query.trim().toLowerCase();
  if (entry === "dollar" && !isNfmInlineSkillToken(query)) return [];
  return skills.flatMap((skill, sourceOrder): NfmSuggestionItem[] => {
    const name = skill.name.toLowerCase();
    const prefix = name.startsWith(term);
    if (
      !prefix &&
      (entry === "dollar" ||
        !(name.includes(term) || skill.displayName.toLowerCase().includes(term)))
    )
      return [];
    const detail = pageSkillLocationsLabel(skill.locations);
    return [
      {
        key: `skill:${skill.name}`,
        title: skill.displayName,
        subtext: detail,
        detail,
        group: getIntl().formatMessage({
          id: "editor.nfmSlashMenu.skills",
          defaultMessage: "Skills",
        }),
        aliases: [skill.name],
        tooltipContent: buildMentionTooltipContent(skill.displayName, [skill.description, detail]),
        mentionRank: {
          family: "skill",
          match: !term
            ? "recent"
            : name === term
              ? "exact_title"
              : prefix
                ? "prefix_title"
                : "title",
          activeContext: false,
          sourceOrder,
        },
        icon: <SkillMentionIcon iconUrl={skill.iconUrl} brandColor={skill.brandColor} />,
        onItemClick: () =>
          insertInlineContent(editor, [{ type: "skillMention", props: { name: skill.name } }, " "]),
      },
    ];
  });
}

function SkillMentionMenu({
  controller,
}: {
  readonly controller: ReturnType<typeof createNfmTypedSuggestionControllerConfig>["skillMention"];
}) {
  const editor = useBlockNoteEditor();
  const { locale } = useIntl();
  const candidates = useSkillMentionPresentation()?.candidates ?? EMPTY_SKILLS;
  const skills = useMemo(
    () => candidates.filter(({ name }) => isNfmInlineSkillToken(name)),
    [candidates],
  );
  const names = useMemo(() => skills.map(({ name }) => name), [skills]);
  const getImmediateItems = useCallback(
    (query: string) =>
      buildNfmSkillMentionSuggestionItems(editor, skills, query, "dollar")
        .sort(
          (left, right) =>
            Number(right.mentionRank?.match === "exact_title") -
            Number(left.mentionRank?.match === "exact_title"),
        )
        .slice(0, 8),
    [editor, skills],
  );
  const getItems = useCallback(
    async (query: string) => getImmediateItems(query),
    [getImmediateItems],
  );
  const shouldClose = useCallback(
    (query: string) => shouldCloseNfmSkillQuery(query, names),
    [names],
  );
  if (!skills.length) return null;
  return (
    <SuggestionMenuController
      triggerCharacter={controller.triggerCharacter}
      shouldOpen={controller.shouldOpen}
      getItems={getItems}
      getImmediateItems={getImmediateItems}
      requestScopeKey={locale}
      shouldCloseOnQuery={shouldClose}
      autoCloseWhenNoItems={false}
      deferPopupWhenQueryEmpty
      {...NFM_SUGGESTION_MENU_CONTROLLER_PORTAL_PROPS}
      suggestionMenuComponent={(props) =>
        props.items.length ? <NfmMentionSuggestionMenuSurface {...props} /> : null
      }
    />
  );
}

function MentionMenu({
  activeProjectId,
  allowPageReferences,
  controller,
}: {
  activeProjectId: string | null;
  allowPageReferences: boolean;
  controller: ReturnType<typeof createNfmTypedSuggestionControllerConfig>["pageMention"][number];
}) {
  const intl = useIntl();
  const editor = useBlockNoteEditor();
  const { buildCreateItems, destinationMenu } = useNfmPageMentionCreateFlow({ activeProjectId });
  const getNonPageItems = useNfmMentionGetItems({
    editor,
    activeProjectId,
  });
  const pageItems = usePageReferenceGetItems("mention");
  const skills = useSkillMentionPresentation()?.candidates ?? EMPTY_SKILLS;
  const getSkillItems = useCallback(
    (query: string) =>
      controller.profile.entry === "broad"
        ? buildNfmSkillMentionSuggestionItems(editor, skills, query, "broad")
        : [],
    [controller.profile.entry, editor, skills],
  );
  const [sectionExpansion, setSectionExpansion] = useState<{
    readonly query: string;
    readonly families: ReadonlySet<MentionSuggestionFamily>;
  }>({ query: "", families: new Set() });
  const expandSection = useCallback((query: string, family: MentionSuggestionFamily) => {
    setSectionExpansion((current) => ({
      query,
      families: new Set([...(current.query === query ? current.families : []), family]),
    }));
  }, []);
  // Only `@` names an agent; `+` and `[[` keep to pages.
  const agentItems = useCallback(
    (query: string) =>
      controller.triggerCharacter === "@" ? buildNfmNodexAgentSuggestionItems(editor, query) : [],
    [controller.triggerCharacter, editor],
  );
  const getItems = useCallback(
    async (query: string) => {
      const [nonPageItems, pageResults] = await Promise.all([
        controller.profile.entry === "broad" ? getNonPageItems(query) : Promise.resolve([]),
        allowPageReferences ? pageItems.getItems(query) : Promise.resolve([]),
      ]);
      return [
        ...agentItems(query),
        ...selectNfmPageMentionSuggestionItems(
          query,
          [...pageResults, ...nonPageItems, ...getSkillItems(query)],
          controller.profile,
          buildCreateItems(query),
          {
            expandedFamilies:
              sectionExpansion.query === query ? sectionExpansion.families : undefined,
            onExpandSection: (family) => expandSection(query, family),
          },
        ),
      ];
    },
    [
      agentItems,
      allowPageReferences,
      buildCreateItems,
      controller.profile,
      expandSection,
      getNonPageItems,
      getSkillItems,
      pageItems,
      sectionExpansion,
    ],
  );
  const getImmediateItems = useCallback(
    (query: string) => [
      ...agentItems(query),
      ...selectNfmPageMentionSuggestionItems(
        query,
        [
          ...(allowPageReferences ? pageItems.getImmediateItems(query) : []),
          ...getSkillItems(query),
        ],
        controller.profile,
        buildCreateItems(query),
        {
          expandedFamilies:
            sectionExpansion.query === query ? sectionExpansion.families : undefined,
          onExpandSection: (family) => expandSection(query, family),
        },
      ),
    ],
    [
      agentItems,
      allowPageReferences,
      buildCreateItems,
      controller.profile,
      expandSection,
      getSkillItems,
      pageItems,
      sectionExpansion,
    ],
  );
  const shouldCloseOnItemClick = useCallback(
    (item: NfmSuggestionItem) =>
      item.mentionUtility?.kind !== "expand_section" && item.mentionCreate === undefined,
    [],
  );
  const temporaryInput = useMemo(
    () => ({
      enabled: true as const,
      emptyCompletion:
        controller.profile.entry === "create_first"
          ? intl.formatMessage({
              id: "editor.nfmSlashMenu.typeToAddOrLink",
              defaultMessage: "Type to add or link page…",
            })
          : undefined,
      getCompletion: resolveNfmPageMentionCompletion,
    }),
    [controller.profile.entry, intl],
  );
  const suggestionMenuComponent = useCallback(
    (props: SuggestionMenuProps<NfmSuggestionItem>) => {
      return destinationMenu ?? <NfmMentionSuggestionMenuSurface {...props} />;
    },
    [destinationMenu],
  );

  return (
    <SuggestionMenuController
      triggerCharacter={controller.triggerCharacter}
      getItems={getItems}
      getImmediateItems={getImmediateItems}
      requestScopeKey={JSON.stringify([pageItems.requestScopeKey, intl.locale])}
      shouldOpen={controller.shouldOpen}
      shouldCloseOnItemClick={shouldCloseOnItemClick}
      autoCloseWhenNoItems={controller.autoCloseWhenNoItems}
      deferPopupWhenQueryEmpty={controller.profile.emptyQueryPopup === "defer"}
      temporaryInput={temporaryInput}
      {...NFM_SUGGESTION_MENU_CONTROLLER_PORTAL_PROPS}
      suggestionMenuComponent={suggestionMenuComponent}
    />
  );
}

function EmbedPageMenu({
  bookmarkRef,
}: {
  bookmarkRef: MutableRefObject<PageReferenceInsertionBookmark | null>;
}) {
  const editor = useBlockNoteEditor();
  const beforeSelect = useCallback(() => {
    const bookmark = bookmarkRef.current;
    if (!isPageReferenceInsertionBookmarkValid(editor, bookmark)) {
      bookmarkRef.current = null;
      editor.focus();
      toast.danger(
        getIntl().formatMessage({
          id: "editor.nfmSlashMenu.lostInsertionPoint",
          defaultMessage: "The Page reference insertion point is no longer available.",
        }),
      );
      return false;
    }
    bookmarkRef.current = null;
    return true;
  }, [bookmarkRef, editor]);
  const pageItems = usePageReferenceGetItems("reference_block", beforeSelect);

  return (
    <SuggestionMenuController
      triggerCharacter={PAGE_EMBED_PICKER_TRIGGER}
      getItems={pageItems.getItems}
      getImmediateItems={pageItems.getImmediateItems}
      requestScopeKey={pageItems.requestScopeKey}
      {...NFM_SUGGESTION_MENU_CONTROLLER_PORTAL_PROPS}
      suggestionMenuComponent={NfmPageSuggestionMenuSurface}
    />
  );
}

/** The file schema supplies its own block palette, with a GFM header on new tables. */
export function NfmFileSlashMenu() {
  const { locale } = useIntl();
  const editor = useBlockNoteEditor();
  const getItems = useCallback(
    async (query: string) => {
      const items = localizeDefaultSlashItems(
        getDefaultReactSlashMenuItems(editor),
        locale,
      ).flatMap((item) => {
        if (!item.key || /^(toggle_|heading_[56]$|emoji$)/.test(item.key)) return [];
        if (item.key !== "table") return [item];
        return [
          {
            ...item,
            onItemClick: () =>
              insertOrUpdateBlockForSlashMenu(editor, {
                type: "table",
                content: {
                  type: "tableContent",
                  headerRows: 1,
                  rows: [{ cells: ["", "", ""] }, { cells: ["", "", ""] }],
                },
              }),
          },
        ];
      });
      return filterSuggestionItems(items, query);
    },
    [editor, locale],
  );

  return (
    <NodexFloatingLayerProvider zIndex={NFM_SUGGESTION_MENU_Z_INDEX}>
      <SuggestionMenuController
        triggerCharacter="/"
        shouldOpen={createNfmTypedSuggestionShouldOpen({
          kind: "slash",
          trigger: "/",
          locale: getBrowserLocale(),
        })}
        getItems={getItems}
        {...NFM_SUGGESTION_MENU_CONTROLLER_PORTAL_PROPS}
        suggestionMenuComponent={NfmSuggestionMenuSurface}
      />
    </NodexFloatingLayerProvider>
  );
}
