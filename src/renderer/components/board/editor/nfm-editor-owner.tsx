import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { BlockNoteEditor, type BlockNoteEditorOptions } from "@blocknote/core";
import type { EditorSurfaceLease } from "@/lib/document-session-registry";
import type { ContentAccessContext } from "../../../../shared/content-access-context";
import { contentAccessContextKey } from "../../../../shared/content-access-context";
import { createUuidV7 } from "../../../../shared/uuid-v7";
import { toast } from "@/components/ui/toast";
import { PAGE_DESCRIPTION_PLACEHOLDER } from "@/lib/page-description-placeholder";
import { nfmSchema } from "./nfm-schema";
import {
  createNfmEditorModeOptions,
  getNfmEditorInstanceKey,
  type NfmEditorSource,
} from "./nfm-editor-source";
import { createNfmEditorPlaceholders } from "./nfm-editor-placeholders";
import {
  createNfmEditorExtensions,
  createNfmPasteHandler,
  NFM_DISABLED_EXTENSIONS,
} from "./nfm-editor-extensions";
import { createNfmLinkExtension } from "./nfm-link-extension";
import {
  NfmStructuralEditingController,
  type NfmStructuralEditingSession,
} from "./nfm-structural-editing-extension";
import type { CopiedSelectionPayload } from "./special-block-copy";

export interface NfmEditorCallbackPorts {
  readonly uploadFile: NonNullable<BlockNoteEditorOptions<any, any, any>["uploadFile"]>;
  readonly resolveFileUrl: NonNullable<BlockNoteEditorOptions<any, any, any>["resolveFileUrl"]>;
  readonly resolveCopiedFileReferences: (
    payload: CopiedSelectionPayload,
  ) => Promise<CopiedSelectionPayload> | null;
}

export interface NfmEditorOwnerInput {
  readonly source: NfmEditorSource;
  readonly accessContext: ContentAccessContext;
  readonly editorInstanceKey: string;
  readonly libraryId?: string;
  readonly placeholder?: string;
  readonly editorSession?: EditorSurfaceLease;
}

/** Every captured document/history authority participates in owner replacement. */
function ownerIdentity(input: NfmEditorOwnerInput): string {
  return JSON.stringify([
    input.editorInstanceKey,
    getNfmEditorInstanceKey({ source: input.source, accessContext: input.accessContext }),
    input.source.storeEpoch,
    input.source.clientSessionId,
    input.libraryId ?? input.editorSession?.descriptor.libraryId,
  ]);
}

function validateRetainedAuthority(input: NfmEditorOwnerInput): void {
  const descriptor = input.editorSession?.descriptor;
  if (
    descriptor &&
    (descriptor.documentId !== input.source.documentId ||
      descriptor.generation !== input.source.generation ||
      descriptor.storeEpoch !== input.source.storeEpoch ||
      contentAccessContextKey(descriptor.accessContext) !==
        contentAccessContextKey(input.accessContext) ||
      (input.libraryId !== undefined && input.libraryId !== descriptor.libraryId))
  )
    throw new Error("A retained editor cannot change its Document or history authority.");
}

/** Editor and command-history lifetime; React views only bind replaceable callbacks. */
export class NfmEditorOwner {
  readonly editor: BlockNoteEditor<
    typeof nfmSchema.blockSchema,
    typeof nfmSchema.inlineContentSchema
  >;
  readonly controller: NfmStructuralEditingController;
  readonly structuralSession: NfmStructuralEditingSession;
  private callbacks: NfmEditorCallbackPorts | null = null;
  private disposePromise: Promise<void> | null = null;
  private retired = false;

  constructor(private readonly input: NfmEditorOwnerInput) {
    validateRetainedAuthority(input);
    const controller = new NfmStructuralEditingController();
    this.controller = controller;
    const pasteHandler = createNfmPasteHandler({
      onStructuralClaimPaste: ({ descriptor, portableBlocks }) =>
        controller.current?.handleStructuralClaimPaste(descriptor, portableBlocks) ?? false,
      onStructuralPaste: (envelope) => {
        const session = controller.current;
        if (session) return session.handlePaste(envelope);
        if (
          envelope.libraryId !== input.libraryId ||
          envelope.storeEpoch !== input.source.storeEpoch
        )
          return false;
        toast.danger("This structural content is still preparing. Try pasting again.");
        return true;
      },
      onStructuralBlockPaste: (blocks) => controller.current?.handleBlockPaste(blocks) ?? false,
      shouldHandleStructuralBlockPaste: () => controller.current?.hasTypedOwnerSelection() ?? false,
    });
    const options = createNfmEditorModeOptions(input.source, {
      schema: nfmSchema,
      generateBlockId: createUuidV7,
      tabBehavior: "prefer-indent" as const,
      placeholders: createNfmEditorPlaceholders(input.placeholder ?? PAGE_DESCRIPTION_PLACEHOLDER),
      uploadFile: (file: File) => this.requireCallbacks().uploadFile(file),
      resolveFileUrl: (url: string) => this.requireCallbacks().resolveFileUrl(url),
      pasteHandler,
      tables: { headers: true, cellBackgroundColor: true, cellTextColor: false, splitCells: false },
      disableExtensions: [...NFM_DISABLED_EXTENSIONS, "link"],
      extensions: createNfmEditorExtensions({
        resolveCopiedFileReferences: (payload) =>
          this.callbacks?.resolveCopiedFileReferences(payload) ?? null,
        onStructuralClipboard: (action, { rootBlockIds, presentation, writeClaim }) =>
          controller.current?.handleClipboard(action, rootBlockIds, presentation, writeClaim) ??
          false,
        onStructuralClipboardUnavailable: () =>
          toast.danger("Structural editing is initializing. Try the action again."),
      }),
      _tiptapOptions: { extensions: [createNfmLinkExtension()] },
    });
    const historyScope =
      input.editorSession?.descriptor ??
      (input.libraryId
        ? {
            libraryId: input.libraryId,
            accessContext: input.accessContext,
            storeEpoch: input.source.storeEpoch,
          }
        : undefined);
    const createEditor = () => {
      const editor = BlockNoteEditor.create(options);
      try {
        controller.attachEditor(editor, historyScope);
        return editor;
      } catch (error) {
        // A failed initialization never enters the retained editor cache.
        void controller
          .dispose()
          .catch(() => undefined)
          .finally(() => editor._tiptapEditor.destroy());
        throw error;
      }
    };
    this.editor =
      input.editorSession?.getOrCreateEditor(ownerIdentity(input), createEditor) ?? createEditor();
    this.structuralSession = controller.attachEditor(this.editor, historyScope);
  }

  get closed(): boolean {
    return this.retired;
  }

  assertIdentity(input: NfmEditorOwnerInput): void {
    if (this.retired || ownerIdentity(input) !== ownerIdentity(this.input))
      throw new Error("A retained editor cannot change its Document or history authority.");
  }

  bindCallbacks(callbacks: NfmEditorCallbackPorts): () => void {
    if (this.retired) return () => undefined;
    this.callbacks = callbacks;
    return () => {
      if (this.callbacks === callbacks) this.callbacks = null;
    };
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.retired = true;
    this.callbacks = null;
    this.disposePromise = this.controller.dispose().finally(() => {
      // Retained surfaces destroy their editor after all retained resources close.
      if (!this.input.editorSession) this.editor._tiptapEditor.destroy();
    });
    return this.disposePromise;
  }

  private requireCallbacks(): NfmEditorCallbackPorts {
    if (!this.callbacks) throw new Error("The editor view is not active");
    return this.callbacks;
  }
}

/** Acquire only after commit, so abandoned renders cannot register history or editors. */
export function NfmEditorOwnerBoundary({
  input,
  children,
}: {
  readonly input: NfmEditorOwnerInput;
  readonly children: (owner: NfmEditorOwner) => ReactNode;
}) {
  return (
    <CommittedNfmEditorOwnerBoundary key={ownerIdentity(input)} input={input}>
      {children}
    </CommittedNfmEditorOwnerBoundary>
  );
}

function CommittedNfmEditorOwnerBoundary({
  input,
  children,
}: {
  readonly input: NfmEditorOwnerInput;
  readonly children: (owner: NfmEditorOwner) => ReactNode;
}) {
  const inputRef = useRef(input);
  inputRef.current = input;
  const [binding, setBinding] = useState<{
    readonly owner: NfmEditorOwner;
    readonly editorSession: EditorSurfaceLease | undefined;
  } | null>(null);
  const { editorInstanceKey, editorSession } = input;
  useLayoutEffect(() => {
    const currentInput = inputRef.current;
    validateRetainedAuthority(currentInput);
    const create = () => new NfmEditorOwner(currentInput);
    const current =
      editorSession?.getOrCreateRetainedResource("nfm-editor-owner", create) ?? create();
    current.assertIdentity(currentInput);
    setBinding({ owner: current, editorSession });
    return () => {
      setBinding(null);
      if (editorSession) return;
      void current.dispose().catch((error: unknown) => {
        console.error("[nfm-editor:close]", error);
      });
    };
  }, [editorInstanceKey, editorSession]);
  if (!binding || binding.editorSession !== editorSession || binding.owner.closed) return null;
  return children(binding.owner);
}
