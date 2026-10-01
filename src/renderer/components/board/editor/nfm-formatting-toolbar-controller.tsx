import { defaultProps, isTableCellSelection, type DefaultProps } from "@blocknote/core";
import { FormattingToolbarExtension } from "@blocknote/core/extensions";
import {
  FormattingToolbar,
  PositionPopover,
  useBlockNoteEditor,
  useEditorState,
  useExtension,
  useExtensionState,
  type FloatingUIOptions,
  type FormattingToolbarProps,
} from "@blocknote/react";
import { useMemo, useRef, type FC } from "react";
import { NodexFloatingLayerProvider } from "@/components/ui/floating-layer";
import {
  isBlockLevelSelection,
  shouldUseTextActionMenu,
  type TextActionMenuEligibilityInput,
} from "./nfm-text-action-menu-model";
import { NFM_TEXT_ACTION_MENU_FLOATING_OPTIONS } from "./nfm-text-action-menu-floating";
import {
  createNfmEditorFloatingMiddleware,
  NFM_EDITOR_FLOATING_UI_PORTAL_ELEMENT,
  NFM_EDITOR_FLOATING_UI_Z_INDEX,
} from "./nfm-blocknote-floating-ui";
import { useNfmSideMenuOpenController, type NfmSideMenuSelectionRange } from "./nfm-side-menu";

export type NfmFormattingToolbarMode = "text-action" | "legacy";

export type NfmFormattingToolbarPresentation =
  | { open: false }
  | {
      open: true;
      mode: NfmFormattingToolbarMode;
      position: NfmSideMenuSelectionRange;
    };

export interface NfmFormattingToolbarSelectedBlockSnapshot {
  type?: string;
  content?: unknown;
  props?: Record<string, unknown>;
}

export interface NfmLegacyFormattingToolbarEligibilityInput {
  isEditable: boolean;
  isSelectionEmpty: boolean;
  isTableCellSelection: boolean;
  isBlockSelection: boolean;
  selectedBlocks: NfmFormattingToolbarSelectedBlockSnapshot[];
}

interface NfmFormattingToolbarEligibilitySnapshot {
  textAction: TextActionMenuEligibilityInput;
  legacy: boolean;
}

type NfmFormattingToolbarComponent = FC<
  FormattingToolbarProps & { mode: NfmFormattingToolbarMode }
>;

function textAlignmentToPlacement(textAlignment: DefaultProps["textAlignment"]) {
  if (textAlignment === "center") return "top";
  if (textAlignment === "right") return "top-end";
  return "top-start";
}

function resolveTextActionMenuEligibility(editor: {
  isEditable: boolean;
  prosemirrorState: {
    selection: {
      empty: boolean;
      from: number;
      to: number;
    };
    doc: {
      textBetween: (from: number, to: number) => string;
    };
  };
  getSelection: () => { blocks: NfmFormattingToolbarSelectedBlockSnapshot[] } | undefined;
  getTextCursorPosition: () => {
    block: NfmFormattingToolbarSelectedBlockSnapshot & {
      props?: { textAlignment?: DefaultProps["textAlignment"] } & Record<string, unknown>;
    };
  };
}): TextActionMenuEligibilityInput {
  const selection = editor.prosemirrorState.selection;
  const selectedBlocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
  const selectedTextLength = selection.empty
    ? 0
    : editor.prosemirrorState.doc.textBetween(selection.from, selection.to).length;

  return {
    isEditable: editor.isEditable,
    isTableCellSelection: isTableCellSelection(
      selection as Parameters<typeof isTableCellSelection>[0],
    ),
    isBlockSelection: isBlockLevelSelection(selection),
    hasInlineContent: selectedBlocks.some((block) => block.content !== undefined),
    selectedTextLength,
    selectionFrom: selection.from,
    selectionTo: selection.to,
  };
}

function hasLegacyFormattingToolbarBlockActions(
  block: NfmFormattingToolbarSelectedBlockSnapshot,
): boolean {
  if (block.type === "table") return true;
  if (typeof block.props?.url === "string") return true;
  return block.content === undefined;
}

export function shouldUseNfmLegacyFormattingToolbar(
  input: NfmLegacyFormattingToolbarEligibilityInput,
): boolean {
  if (!input.isEditable) return false;
  if (input.isTableCellSelection) return true;
  if (input.isSelectionEmpty) return false;
  return input.selectedBlocks.some(hasLegacyFormattingToolbarBlockActions);
}

function resolveFormattingToolbarEligibility(editor: {
  isEditable: boolean;
  prosemirrorState: {
    selection: {
      empty: boolean;
      from: number;
      to: number;
    };
    doc: {
      textBetween: (from: number, to: number) => string;
    };
  };
  getSelection: () => { blocks: NfmFormattingToolbarSelectedBlockSnapshot[] } | undefined;
  getTextCursorPosition: () => {
    block: NfmFormattingToolbarSelectedBlockSnapshot & {
      props?: { textAlignment?: DefaultProps["textAlignment"] } & Record<string, unknown>;
    };
  };
}): NfmFormattingToolbarEligibilitySnapshot {
  const selection = editor.prosemirrorState.selection;
  const selectedBlocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
  const textAction = resolveTextActionMenuEligibility(editor);

  return {
    textAction,
    legacy: shouldUseNfmLegacyFormattingToolbar({
      isEditable: editor.isEditable,
      isSelectionEmpty: selection.empty,
      isTableCellSelection: textAction.isTableCellSelection,
      isBlockSelection: Boolean(textAction.isBlockSelection),
      selectedBlocks,
    }),
  };
}

export function resolveNfmFormattingToolbarFloatingMode(
  input: TextActionMenuEligibilityInput,
): NfmFormattingToolbarMode {
  return shouldUseTextActionMenu(input) ? "text-action" : "legacy";
}

export function resolveNfmFormattingToolbarEffectiveFloatingMode(input: {
  show: boolean;
  currentMode: NfmFormattingToolbarMode;
  lastVisibleMode: NfmFormattingToolbarMode;
}): NfmFormattingToolbarMode {
  return input.show ? input.currentMode : input.lastVisibleMode;
}

export function shouldSuppressNfmFormattingToolbarForSelection(input: {
  show: boolean;
  selectionRange: NfmSideMenuSelectionRange;
  suppressionRange: NfmSideMenuSelectionRange | null;
}) {
  return (
    input.show &&
    input.suppressionRange !== null &&
    input.selectionRange.from === input.suppressionRange.from &&
    input.selectionRange.to === input.suppressionRange.to
  );
}

export function resolveNfmFormattingToolbarPresentation(input: {
  show: boolean;
  selectionRange: NfmSideMenuSelectionRange;
  suppressionRange: NfmSideMenuSelectionRange | null;
  textActionEligibility: TextActionMenuEligibilityInput;
  legacyEligibility: boolean;
}): NfmFormattingToolbarPresentation {
  if (!input.show) return { open: false };

  // BlockNote's store and selection-derived eligibility can settle in
  // different React commits. A collapsed selection is never a valid toolbar
  // anchor, even when legacy eligibility still describes the previous block.
  if (input.selectionRange.from === input.selectionRange.to) {
    return { open: false };
  }

  if (shouldSuppressNfmFormattingToolbarForSelection(input)) {
    return { open: false };
  }

  if (shouldUseTextActionMenu(input.textActionEligibility)) {
    return {
      open: true,
      mode: "text-action",
      position: input.selectionRange,
    };
  }

  if (!input.legacyEligibility) return { open: false };

  return {
    open: true,
    mode: "legacy",
    position: input.selectionRange,
  };
}

export function NfmFormattingToolbarController(props: {
  formattingToolbar?: NfmFormattingToolbarComponent;
  floatingUIOptions?: FloatingUIOptions;
  portalElement?: HTMLElement | null;
}) {
  const editor = useBlockNoteEditor();
  const formattingToolbar = useExtension(FormattingToolbarExtension, {
    editor,
  });
  const show = useExtensionState(FormattingToolbarExtension, {
    editor,
  });
  const sideMenuOpenController = useNfmSideMenuOpenController();

  // Subscribe to ProseMirror transactions, then read the live state below.
  // The formatting-toolbar store and selection events are separate external
  // stores, so a derived selector can otherwise render one stale snapshot
  // between the two updates.
  useEditorState({
    editor,
    selector: ({ transactionNumber }) => transactionNumber,
  });
  const currentSelectionRange = {
    from: editor.prosemirrorState.selection.from,
    to: editor.prosemirrorState.selection.to,
  };
  const currentToolbarEligibility = resolveFormattingToolbarEligibility(editor);
  const currentFloatingMode = resolveNfmFormattingToolbarFloatingMode(
    currentToolbarEligibility.textAction,
  );
  const currentPlacement = textAlignmentToPlacement(
    (
      editor.getTextCursorPosition().block as {
        props?: { textAlignment?: DefaultProps["textAlignment"] };
      }
    ).props?.textAlignment ?? defaultProps.textAlignment.default,
  );
  const presentation = resolveNfmFormattingToolbarPresentation({
    show,
    selectionRange: currentSelectionRange,
    suppressionRange: sideMenuOpenController.formattingToolbarSuppressionRange,
    textActionEligibility: currentToolbarEligibility.textAction,
    legacyEligibility: currentToolbarEligibility.legacy,
  });
  const lastVisibleFloatingModeRef = useRef<NfmFormattingToolbarMode>(currentFloatingMode);

  if (presentation.open) {
    lastVisibleFloatingModeRef.current = presentation.mode;
  }

  const effectiveFloatingMode = resolveNfmFormattingToolbarEffectiveFloatingMode({
    show: presentation.open,
    currentMode: presentation.open ? presentation.mode : currentFloatingMode,
    lastVisibleMode: lastVisibleFloatingModeRef.current,
  });
  const position = presentation.open ? presentation.position : undefined;
  const textActionFloatingOptions =
    effectiveFloatingMode === "text-action" ? NFM_TEXT_ACTION_MENU_FLOATING_OPTIONS : undefined;

  const floatingUIOptions = useMemo<FloatingUIOptions>(
    () => ({
      ...props.floatingUIOptions,
      ...textActionFloatingOptions,
      useFloatingOptions: {
        open: presentation.open,
        onOpenChange: (open, _event, reason) => {
          formattingToolbar.store.setState(open);

          if (reason === "escape-key") {
            editor.focus();
          }
        },
        placement: currentPlacement,
        strategy: "fixed",
        middleware: createNfmEditorFloatingMiddleware(10),
        ...props.floatingUIOptions?.useFloatingOptions,
        ...textActionFloatingOptions?.useFloatingOptions,
      },
      focusManagerProps: {
        disabled: true,
        ...props.floatingUIOptions?.focusManagerProps,
        ...textActionFloatingOptions?.focusManagerProps,
      },
      elementProps: {
        ...props.floatingUIOptions?.elementProps,
        ...textActionFloatingOptions?.elementProps,
        style: {
          zIndex: NFM_EDITOR_FLOATING_UI_Z_INDEX,
          ...props.floatingUIOptions?.elementProps?.style,
          ...textActionFloatingOptions?.elementProps?.style,
        },
      },
      freezeChildrenOnClose: true,
    }),
    [
      editor,
      formattingToolbar.store,
      currentPlacement,
      presentation.open,
      props.floatingUIOptions,
      textActionFloatingOptions,
    ],
  );

  const Component = props.formattingToolbar;

  return (
    <PositionPopover
      position={position}
      portalElement={props.portalElement ?? NFM_EDITOR_FLOATING_UI_PORTAL_ELEMENT}
      {...floatingUIOptions}
    >
      {presentation.open ? (
        <NodexFloatingLayerProvider zIndex={NFM_EDITOR_FLOATING_UI_Z_INDEX}>
          {Component ? <Component mode={presentation.mode} /> : <FormattingToolbar />}
        </NodexFloatingLayerProvider>
      ) : null}
    </PositionPopover>
  );
}
