import { defineMessage, getIntl, type MessageDescriptor } from "@/lib/i18n";
import type { LibraryStructuralTurnIntoTarget } from "../../shared/library-module";

export interface NfmTurnIntoDefinition {
  readonly key: string;
  readonly label: string;
  readonly target: LibraryStructuralTurnIntoTarget;
  readonly localPatch: {
    readonly type: string;
    readonly props?: Readonly<Record<string, boolean | number | string>>;
  };
}

const heading = (
  key: string,
  label: MessageDescriptor,
  level: 1 | 2 | 3,
  toggleable: boolean,
): NfmTurnIntoDefinition => ({
  key,
  get label() {
    return getIntl().formatMessage(label);
  },
  target: {
    kind: "heading",
    level: level === 1 ? "one" : level === 2 ? "two" : "three",
    toggleable,
  },
  localPatch: {
    type: "heading",
    props: { level, isToggleable: toggleable },
  },
});

export const NFM_TURN_INTO_DEFINITIONS = [
  {
    key: "paragraph",
    get label() {
      return getIntl().formatMessage({ id: "lib.nfmTurnIntoTargets.text", defaultMessage: "Text" });
    },
    target: { kind: "paragraph" },
    localPatch: { type: "paragraph" },
  },
  heading(
    "heading-1",
    defineMessage({ id: "lib.nfmTurnIntoTargets.headingOne", defaultMessage: "Heading 1" }),
    1,
    false,
  ),
  heading(
    "heading-2",
    defineMessage({ id: "lib.nfmTurnIntoTargets.headingTwo", defaultMessage: "Heading 2" }),
    2,
    false,
  ),
  heading(
    "heading-3",
    defineMessage({ id: "lib.nfmTurnIntoTargets.headingThree", defaultMessage: "Heading 3" }),
    3,
    false,
  ),
  heading(
    "toggle-heading-1",
    defineMessage({
      id: "lib.nfmTurnIntoTargets.toggleHeadingOne",
      defaultMessage: "Toggle heading 1",
    }),
    1,
    true,
  ),
  heading(
    "toggle-heading-2",
    defineMessage({
      id: "lib.nfmTurnIntoTargets.toggleHeadingTwo",
      defaultMessage: "Toggle heading 2",
    }),
    2,
    true,
  ),
  heading(
    "toggle-heading-3",
    defineMessage({
      id: "lib.nfmTurnIntoTargets.toggleHeadingThree",
      defaultMessage: "Toggle heading 3",
    }),
    3,
    true,
  ),
  {
    key: "bullet-list",
    get label() {
      return getIntl().formatMessage({
        id: "lib.nfmTurnIntoTargets.bulletedList",
        defaultMessage: "Bulleted list",
      });
    },
    target: { kind: "bulleted_list" },
    localPatch: { type: "bulletListItem" },
  },
  {
    key: "numbered-list",
    get label() {
      return getIntl().formatMessage({
        id: "lib.nfmTurnIntoTargets.numberedList",
        defaultMessage: "Numbered list",
      });
    },
    target: { kind: "numbered_list" },
    localPatch: { type: "numberedListItem" },
  },
  {
    key: "todo-list",
    get label() {
      return getIntl().formatMessage({
        id: "lib.nfmTurnIntoTargets.todoList",
        defaultMessage: "To-do list",
      });
    },
    target: { kind: "todo_list" },
    localPatch: { type: "checkListItem" },
  },
  {
    key: "toggle-list",
    get label() {
      return getIntl().formatMessage({
        id: "lib.nfmTurnIntoTargets.toggleList",
        defaultMessage: "Toggle list",
      });
    },
    target: { kind: "toggle_list" },
    localPatch: { type: "toggleListItem" },
  },
  {
    key: "quote",
    get label() {
      return getIntl().formatMessage({
        id: "lib.nfmTurnIntoTargets.quote",
        defaultMessage: "Quote",
      });
    },
    target: { kind: "quote" },
    localPatch: { type: "quote" },
  },
  {
    key: "callout",
    get label() {
      return getIntl().formatMessage({
        id: "lib.nfmTurnIntoTargets.callout",
        defaultMessage: "Callout",
      });
    },
    target: { kind: "callout" },
    localPatch: { type: "callout" },
  },
  {
    key: "prompt",
    get label() {
      return getIntl().formatMessage({
        id: "lib.nfmTurnIntoTargets.prompt",
        defaultMessage: "Prompt",
      });
    },
    target: { kind: "prompt" },
    localPatch: { type: "prompt", props: { sentSessionId: "", sentAt: "", sentMessageId: "" } },
  },
  {
    key: "code",
    get label() {
      return getIntl().formatMessage({ id: "lib.nfmTurnIntoTargets.code", defaultMessage: "Code" });
    },
    target: { kind: "code" },
    localPatch: { type: "codeBlock" },
  },
  {
    key: "equation",
    get label() {
      return getIntl().formatMessage({
        id: "lib.nfmTurnIntoTargets.equation",
        defaultMessage: "Block equation",
      });
    },
    target: { kind: "equation" },
    localPatch: { type: "mathBlock" },
  },
] as const satisfies readonly NfmTurnIntoDefinition[];

export interface NfmTurnBlocksIntoInput {
  readonly rootBlockIds: readonly string[];
  readonly expandedBlockIds: readonly string[];
  readonly target: LibraryStructuralTurnIntoTarget;
  readonly localPatch: NfmTurnIntoDefinition["localPatch"];
}

/** Groups an ordinary-only multi-Block reclassification into one Yjs history item. */
export function applyLocalNfmTurnInto(
  editor: {
    transact: (callback: () => void) => void;
    updateBlock: unknown;
  },
  blocks: readonly unknown[],
  patch: NfmTurnIntoDefinition["localPatch"],
): void {
  const updateBlock = editor.updateBlock as (block: unknown, patch: unknown) => unknown;
  editor.transact(() => {
    for (const block of blocks) updateBlock.call(editor, block, patch);
  });
}
