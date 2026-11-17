import type { MessageDescriptor } from "@/lib/i18n";
import type { ReactNode } from "react";
import type { ComposerPromptMentionInput } from "../composer-prompt-editor";

export type ComposerSlashCommandTrigger = "/" | "@";

export interface ComposerSlashTriggerState {
  active: boolean;
  trigger: ComposerSlashCommandTrigger;
  query: string;
  from: number;
  to: number;
}

/** Edits the draft where the slash query was typed. */
export interface ComposerSlashDraftInsertion {
  /** Replaces the slash query with a chip. */
  insertMention: (mention: ComposerPromptMentionInput) => void;
  /** Replaces the slash query with text, such as an Agent command to finish typing. */
  insertText: (text: string) => void;
}

/**
 * What choosing a command does. `run` clears the slash query, closes the menu and acts; `insert`
 * turns the query into draft content; `submenu` lists the command's choices in place.
 */
export type ComposerSlashCommandAction =
  | { readonly kind: "run"; readonly run: () => void | Promise<void> }
  | { readonly kind: "insert"; readonly insert: (draft: ComposerSlashDraftInsertion) => void }
  | { readonly kind: "submenu"; readonly submenu: ComposerSlashSubmenu };

/** Skills and the Agent's own commands follow the chat's commands, each under a heading. */
export type ComposerSlashSectionKind = "skills" | "agent";

export interface ComposerSlashCommandSection {
  readonly kind: ComposerSlashSectionKind;
  readonly label: string;
}

export interface ComposerSlashCommand {
  id: string;
  /** English title used to match slash queries. */
  title: string;
  titleMessage?: MessageDescriptor;
  description?: string;
  /** Unheaded commands lead the menu. */
  section?: ComposerSlashCommandSection;
  /** Other words that find the command. */
  searchAliases?: readonly string[];
  /** Agent command names this command stands for, so the Agent's entry is not listed twice. */
  supersedes?: readonly string[];
  icon: ReactNode;
  /** Where the command comes from or what it takes, shown at the end of its row. */
  trailing?: ReactNode;
  triggers?: readonly ComposerSlashCommandTrigger[];
  requiresEmptyComposer?: boolean;
  isEnabled?: boolean;
  isVisible?: boolean;
  action: ComposerSlashCommandAction;
}

export interface ComposerSlashSubmenu {
  readonly sections: readonly ComposerSlashSubmenuSection[];
}

export interface ComposerSlashSubmenuSection {
  readonly id: string;
  /** Shown while more than one section has rows. */
  readonly title?: string;
  readonly items: readonly ComposerSlashSubmenuItem[];
  /** The rows answer a search and nothing else, as models turned off in Settings do. */
  readonly showOnlyWhenSearching?: boolean;
  /** Shown when the section has no rows, such as while they load or when there are none. */
  readonly emptyState?: ReactNode;
  readonly loading?: boolean;
}

export interface ComposerSlashSubmenuItem {
  readonly id: string;
  readonly title: string;
  readonly description?: string | null;
  readonly searchAliases?: readonly string[];
  readonly icon?: ReactNode;
  readonly trailing?: ReactNode;
  /** The setting in effect: checked, and highlighted when the submenu opens. */
  readonly current?: boolean;
  /** Listed but not choosable now; `tooltip` says why. */
  readonly disabled?: boolean;
  readonly tooltip?: string | null;
  /** Absent for a row that only reports state, such as an MCP server's status. */
  readonly run?: () => void | Promise<void>;
}

export type ComposerSlashHighlightSource = "keyboard" | "pointer" | "programmatic";

export interface ComposerSlashHighlightIntent {
  rowId: string | null;
  source: ComposerSlashHighlightSource;
}

export interface ComposerSlashCommandMatch {
  command: ComposerSlashCommand;
  /** Title as shown, which the highlight and the order follow. */
  title: string;
  score: number;
}

export interface ComposerSlashCommandGroup {
  id: string;
  label: string | null;
  matches: ComposerSlashCommandMatch[];
}

export interface ComposerSlashSubmenuSectionView {
  readonly id: string;
  readonly title: string | null;
  readonly items: readonly ComposerSlashSubmenuItem[];
  readonly emptyState: ReactNode | null;
  readonly loading: boolean;
}
