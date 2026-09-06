import { Activity, Component, StrictMode, Suspense, useLayoutEffect, type ReactNode } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { BlockNoteViewRaw } from "@blocknote/react";
import { BlockNoteEditor } from "@blocknote/core";
import { expect, test, vi } from "vite-plus/test";
import { createPageDocumentGenesis } from "../../../../shared/block-documents/block-document-codec";
import type { OwnedDocumentDescriptor } from "../../../../shared/block-documents";
import type { BlockDocumentSurfaceRuntime } from "@/lib/block-document-surface-runtime";
import { EditorSurfaceLease } from "@/lib/document-session-registry";
import { libraryContentAccess } from "../../../../shared/content-access-context";
import { pressProseMirrorShortcut } from "@/test/prosemirror-shortcut";
import { getNfmEditorInstanceKey } from "./nfm-editor-source";
import {
  NfmEditorOwner,
  NfmEditorOwnerBoundary,
  type NfmEditorOwnerInput,
} from "./nfm-editor-owner";

const settle = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

function fixture(retained: boolean, nfm = "") {
  let blockIndex = 0;
  const { document } = createPageDocumentGenesis({
    documentId: `document:editor-owner-${retained}`,
    title: "Editor lifecycle",
    nfm,
    allocateBlockId: () =>
      blockIndex++ === 0 ? "block:editor-owner" : `block:editor-owner-${blockIndex}`,
  });
  const source = {
    kind: "collaborative-document" as const,
    documentId: document.guid,
    storeEpoch: "epoch:editor-owner",
    generation: 1,
    clientSessionId: "surface:editor-owner",
    fragment: document.getXmlFragment("body"),
    user: { name: "Test", color: "#2563eb" },
  };
  const descriptor: OwnedDocumentDescriptor = {
    libraryId: "library:editor-owner",
    accessContext: libraryContentAccess,
    ownerBlockId: "page:editor-owner",
    ownerType: "page",
    ownerLifecycle: "active",
    documentId: document.guid,
    authorization: null,
    storeEpoch: source.storeEpoch,
    generation: 1,
    headSeq: 1,
    schemaKey: "nodex.page",
    schemaVersion: 1,
    readiness: "ready",
    sync: { kind: "yjs", stateVector: new Uint8Array() },
  };
  const editorSession = retained
    ? new EditorSurfaceLease({
        key: "editor-owner-test",
        descriptor,
        runtime: { clearLocalAwareness: () => undefined } as unknown as BlockDocumentSurfaceRuntime,
        releaseRuntime: async () => undefined,
      })
    : undefined;
  const input: NfmEditorOwnerInput = {
    source,
    accessContext: libraryContentAccess,
    editorInstanceKey: getNfmEditorInstanceKey({ source, accessContext: libraryContentAccess }),
    editorSession,
  };
  return { document, input, editorSession };
}

function EditorView({
  owner,
  onBind,
  resolveFileUrl,
}: {
  readonly owner: NfmEditorOwner;
  readonly onBind: (owner: NfmEditorOwner) => void;
  readonly resolveFileUrl?: (url: string) => Promise<string>;
}) {
  useLayoutEffect(() => {
    expect(owner.closed).toBe(false);
    expect(owner.editor._tiptapEditor.isDestroyed).toBe(false);
    onBind(owner);
    return owner.bindCallbacks({
      uploadFile: async () => "",
      resolveFileUrl: resolveFileUrl ?? (async (url) => url),
      resolveCopiedFileReferences: () => null,
    });
  }, [owner, onBind, resolveFileUrl]);
  return <BlockNoteViewRaw editor={owner.editor} />;
}

for (const retained of [false, true]) {
  test(`${retained ? "retained" : "temporary"} editor survives StrictMode, rerender, and Activity with live history`, async () => {
    const { document, input, editorSession } = fixture(retained);
    let current: NfmEditorOwner | null = null;
    const onBind = (owner: NfmEditorOwner) => {
      current = owner;
    };
    const requireOwner = (): NfmEditorOwner => {
      if (!current) throw new Error("Editor did not mount");
      return current;
    };
    const content = (visible: boolean) => (
      <StrictMode>
        <Activity mode={visible ? "visible" : "hidden"}>
          <NfmEditorOwnerBoundary input={{ ...input, accessContext: { kind: "library" } }}>
            {(owner) => <EditorView owner={owner} onBind={onBind} />}
          </NfmEditorOwnerBoundary>
        </Activity>
      </StrictMode>
    );
    const result = render(content(true));
    try {
      await act(settle);
      const first = requireOwner();
      await act(async () => {
        first.editor.updateBlock("block:editor-owner", { content: "local edit" });
        await settle();
      });
      await act(async () => {
        result.rerender(content(true));
        await settle();
      });
      expect(requireOwner()).toBe(first);
      expect(first.controller.attachEditor(first.editor, editorSession?.descriptor)).toBe(
        first.structuralSession,
      );
      await act(async () => {
        expect(pressProseMirrorShortcut(first.editor, { key: "z", modKey: true })).toBe(true);
        await first.structuralSession.whenIdle();
        await settle();
      });
      expect(first.editor.document[0]?.content).toEqual([]);
      await act(async () => {
        result.rerender(content(false));
        await settle();
      });
      expect(first.closed).toBe(!retained);
      await act(async () => {
        result.rerender(content(true));
        await settle();
      });
      const restored = requireOwner();
      expect(restored.closed).toBe(false);
      if (retained) expect(restored).toBe(first);
      else expect(restored).not.toBe(first);
      await act(async () => {
        restored.editor.updateBlock("block:editor-owner", { content: "after reveal" });
        expect(pressProseMirrorShortcut(restored.editor, { key: "z", modKey: true })).toBe(true);
        await restored.structuralSession.whenIdle();
        await settle();
      });
      expect(restored.editor.document[0]?.content).toEqual([]);
    } finally {
      await act(async () => {
        result.unmount();
        await editorSession?.dispose();
        await current?.dispose();
      });
      document.destroy();
    }
  });
}

for (const retained of [false, true])
  test(`waits for structural cleanup before destroying a ${retained ? "retained" : "temporary"} editor`, async () => {
    const { document, input, editorSession } = fixture(retained);
    const owner =
      editorSession?.getOrCreateRetainedResource(
        "nfm-editor-owner",
        () => new NfmEditorOwner(input),
      ) ?? new NfmEditorOwner(input);
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const close = owner.structuralSession.close.bind(owner.structuralSession);
    vi.spyOn(owner.structuralSession, "close").mockImplementation(async () => {
      await pending;
      await close();
    });
    const destroy = vi.spyOn(owner.editor._tiptapEditor, "destroy");
    const ownerClosing = owner.dispose();
    const closing = editorSession?.dispose() ?? ownerClosing;
    expect(owner.closed).toBe(true);
    expect(owner.dispose()).toBe(ownerClosing);
    expect(destroy).not.toHaveBeenCalled();
    finish();
    await closing;
    expect(destroy).toHaveBeenCalledTimes(1);
    document.destroy();
  });

test("initial image resolution sees the committed view callback port", async () => {
  const { document, input } = fixture(
    false,
    'An image\n\n<image source="https://example.test/image.png">Image</image>',
  );
  const resolveFileUrl = vi.fn(
    async () => "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
  );
  let owner: NfmEditorOwner | null = null;
  const result = render(
    <StrictMode>
      <NfmEditorOwnerBoundary input={input}>
        {(current) => (
          <EditorView
            owner={current}
            onBind={(value) => {
              owner = value;
            }}
            resolveFileUrl={resolveFileUrl}
          />
        )}
      </NfmEditorOwnerBoundary>
    </StrictMode>,
  );
  try {
    await waitFor(() =>
      expect(resolveFileUrl).toHaveBeenCalledWith("https://example.test/image.png"),
    );
    await act(settle);
  } finally {
    await act(async () => {
      result.unmount();
      await owner?.dispose();
    });
    document.destroy();
  }
});

test("draft document retirement before view cleanup is safe", async () => {
  const { document, input } = fixture(false);
  const owner = new NfmEditorOwner(input);
  document.destroy();
  await owner.dispose();
  expect(owner.editor._tiptapEditor.isDestroyed).toBe(true);
});

test("failed retirement destroys the old editor without poisoning its replacement", async () => {
  const { document, input } = fixture(false);
  let current: NfmEditorOwner | null = null;
  const onBind = (owner: NfmEditorOwner) => {
    current = owner;
  };
  const requireOwner = (): NfmEditorOwner => {
    if (!current) throw new Error("Editor did not mount");
    return current;
  };
  const content = (visible: boolean) => (
    <Activity mode={visible ? "visible" : "hidden"}>
      <NfmEditorOwnerBoundary input={input}>
        {(owner) => <EditorView owner={owner} onBind={onBind} />}
      </NfmEditorOwnerBoundary>
    </Activity>
  );
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const failure = new Error("History retirement failed");
  const result = render(content(true));
  try {
    await act(settle);
    const first = requireOwner();
    const close = first.structuralSession.close.bind(first.structuralSession);
    vi.spyOn(first.structuralSession, "close").mockImplementation(async () => {
      await pending;
      await close();
      throw failure;
    });
    await act(async () => {
      result.rerender(content(false));
      await settle();
    });
    await act(async () => {
      result.rerender(content(true));
      await settle();
    });
    const replacement = requireOwner();
    expect(replacement).not.toBe(first);
    await act(async () => {
      finish();
      await expect(first.dispose()).rejects.toBe(failure);
      await settle();
    });
    expect(first.editor._tiptapEditor.isDestroyed).toBe(true);
    expect(replacement.closed).toBe(false);
    expect(log).toHaveBeenCalledExactlyOnceWith("[nfm-editor:close]", failure);
  } finally {
    finish();
    await act(async () => {
      result.unmount();
      await current?.dispose();
    });
    log.mockRestore();
    document.destroy();
  }
});

test("authority replacement creates a new owner before rendering its view", async () => {
  const { document, input } = fixture(false);
  let current: NfmEditorOwner | null = null;
  const onBind = (owner: NfmEditorOwner) => {
    current = owner;
  };
  const requireOwner = (): NfmEditorOwner => {
    if (!current) throw new Error("Editor did not mount");
    return current;
  };
  const content = (value: NfmEditorOwnerInput) => (
    <NfmEditorOwnerBoundary input={value}>
      {(owner) => <EditorView owner={owner} onBind={onBind} />}
    </NfmEditorOwnerBoundary>
  );
  const result = render(content(input));
  try {
    await act(settle);
    const before = requireOwner();
    await act(async () => {
      result.rerender(
        content({
          ...input,
          libraryId: "library:replacement",
          source: { ...input.source, storeEpoch: "epoch:replacement" },
        }),
      );
      await settle();
    });
    expect(before.closed).toBe(true);
    expect(requireOwner()).not.toBe(before);
    expect(requireOwner().closed).toBe(false);
  } finally {
    await act(async () => {
      result.unmount();
      await current?.dispose();
    });
    document.destroy();
  }
});

test("a retained lease rejects another authority before editor allocation", async () => {
  const { document, input, editorSession } = fixture(true);
  const create = vi.spyOn(BlockNoteEditor, "create");
  try {
    expect(
      () =>
        new NfmEditorOwner({ ...input, source: { ...input.source, storeEpoch: "epoch:another" } }),
    ).toThrow("cannot change its Document or history authority");
    expect(create).not.toHaveBeenCalled();
  } finally {
    create.mockRestore();
    await editorSession?.dispose();
    document.destroy();
  }
});

test("lease replacement never binds the previous editor to the new surface", async () => {
  const { document, input, editorSession } = fixture(true);
  if (!editorSession) throw new Error("Expected a retained surface");
  const replacement = new EditorSurfaceLease({
    key: "replacement-surface",
    descriptor: editorSession.descriptor,
    runtime: editorSession.runtime,
    releaseRuntime: async () => undefined,
  });
  const bindings: { owner: NfmEditorOwner; lease: EditorSurfaceLease }[] = [];
  const content = (lease: EditorSurfaceLease) => (
    <NfmEditorOwnerBoundary input={{ ...input, editorSession: lease }}>
      {(owner) => (
        <EditorView
          owner={owner}
          onBind={(value) => {
            bindings.push({ owner: value, lease });
          }}
        />
      )}
    </NfmEditorOwnerBoundary>
  );
  const result = render(content(editorSession));
  try {
    await act(settle);
    const original = bindings[0]?.owner;
    expect(original).toBeDefined();
    await act(async () => {
      result.rerender(content(replacement));
      await settle();
    });
    const replacements = bindings.filter(({ lease }) => lease === replacement);
    expect(replacements.length).toBeGreaterThan(0);
    expect(replacements.every(({ owner }) => owner !== original)).toBe(true);
  } finally {
    await act(async () => {
      result.unmount();
      await editorSession.dispose();
      await replacement.dispose();
    });
    document.destroy();
  }
});

class OwnerFailureBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div role="alert">Editor authority changed</div>
    ) : (
      this.props.children
    );
  }
}

for (const replacement of ["scope", "epoch", "fragment"] as const)
  test(`a retained boundary rejects a cached owner after ${replacement} replacement`, async () => {
    const { document, input, editorSession } = fixture(true);
    const alternative = fixture(false);
    let first: NfmEditorOwner | null = null;
    const binds: NfmEditorOwner[] = [];
    const onBind = (owner: NfmEditorOwner) => {
      first ??= owner;
      binds.push(owner);
    };
    const caught: unknown[] = [];
    const content = (value: NfmEditorOwnerInput) => (
      <OwnerFailureBoundary>
        <NfmEditorOwnerBoundary input={value}>
          {(owner) => <EditorView owner={owner} onBind={onBind} />}
        </NfmEditorOwnerBoundary>
      </OwnerFailureBoundary>
    );
    const result = render(content(input), {
      onCaughtError: (error) => {
        caught.push(error);
      },
    });
    try {
      await act(settle);
      const changed: NfmEditorOwnerInput = {
        ...input,
        ...(replacement === "scope"
          ? { accessContext: { kind: "project", projectId: "project:another" } }
          : {}),
        source: {
          ...input.source,
          ...(replacement === "epoch" ? { storeEpoch: "epoch:another" } : {}),
          ...(replacement === "fragment" ? { fragment: alternative.input.source.fragment } : {}),
        },
      };
      await act(async () => {
        result.rerender(content(changed));
        await settle();
      });
      expect(result.getByRole("alert")).toBeTruthy();
      expect(caught).toHaveLength(1);
      expect(String(caught[0])).toContain("cannot change its Document or history authority");
      expect(binds.every((owner) => owner === first)).toBe(true);
    } finally {
      await act(async () => {
        result.unmount();
        await editorSession?.dispose();
      });
      document.destroy();
      alternative.document.destroy();
    }
  });

test("a suspended, uncommitted editor boundary allocates no editor", async () => {
  const { document, input } = fixture(false);
  const acquire = vi.spyOn(BlockNoteEditor, "create");
  const never = new Promise<void>(() => {});
  function Suspend(): never {
    throw never;
  }
  const result = render(
    <Suspense fallback={null}>
      <NfmEditorOwnerBoundary input={input}>
        {(owner) => <EditorView owner={owner} onBind={() => undefined} />}
      </NfmEditorOwnerBoundary>
      <Suspend />
    </Suspense>,
  );
  try {
    await act(settle);
    expect(acquire).not.toHaveBeenCalled();
  } finally {
    result.unmount();
    acquire.mockRestore();
    document.destroy();
  }
});
