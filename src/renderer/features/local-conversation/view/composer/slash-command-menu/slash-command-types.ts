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

export interface ComposerSlashCommandSelection {
  source: "inline" | "dialog";
  /** Puts a chip in the draft: where the slash query was, or at the caret from the dialog. */
  insertMention: (mention: ComposerPromptMentionInput) => void;
}

export interface ComposerSlashInlineSelection extends ComposerSlashCommandSelection {
  source: "inline";
  trigger: ComposerSlashTriggerState;
  replaceTrigger: (text: string) => void;
  clearTrigger: () => void;
}

export interface ComposerSlashCommandContentProps {
  close: () => void;
  back: () => void;
}

export interface ComposerSlashCommand {
  id: string;
  /** English title used to match slash queries. */
  title: string;
  titleMessage?: MessageDescriptor;
  description?: string;
  /** Heading of the command's section; commands without one lead the menu unheaded. */
  group?: string;
  /** Other words that find the command. */
  searchAliases?: readonly string[];
  icon: ReactNode;
  /** Where the command comes from, shown at the end of its row. */
  trailing?: ReactNode;
  triggers?: readonly ComposerSlashCommandTrigger[];
  requiresEmptyComposer?: boolean;
  isEnabled?: boolean;
  isVisible?: boolean;
  telemetryName?: string;
  dismissOnInput?: boolean;
  Content?: (props: ComposerSlashCommandContentProps) => ReactNode;
  onSelect?: (selection: ComposerSlashCommandSelection) => void | Promise<void>;
  onSelectFromInlineSlash?: (selection: ComposerSlashInlineSelection) => void | Promise<void>;
}

export interface ComposerSlashCommandGroup {
  id: string;
  label: string | null;
  matches: ComposerSlashCommandMatch[];
}

export type ComposerSlashCommandHighlightSource = "keyboard" | "pointer" | "programmatic";

export interface ComposerSlashCommandHighlightIntent {
  commandId: string | null;
  source: ComposerSlashCommandHighlightSource;
}

export interface ComposerSlashCommandMatch {
  command: ComposerSlashCommand;
  /** Title as shown, which the highlight and the order follow. */
  title: string;
  score: number;
}
