import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteViewRaw } from "@blocknote/react";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { useMemo, useLayoutEffect, type ReactNode } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import {
  ContentSearchProvider,
  useContentSearch,
  useRegisterContentSearchSource,
  type ContentSearchController,
} from "@/features/content-search/content-search-context";
import { ContentSearchSurface } from "@/features/content-search/content-search-surface";
import { handleWorkbenchShortcut } from "@/lib/use-workbench-shortcuts";
import { nfmSchema } from "./nfm-schema";
import { nfmSearchExtension, getNfmSearchState } from "./search-extension";
import { createPageContentSearchSource } from "./page-content-search-source";
import "../../../globals.css";

const editors: BlockNoteEditor<any, any, any>[] = [];
let find: ContentSearchController;
afterEach(() => {
  cleanup();
  for (const editor of editors.splice(0)) editor._tiptapEditor.destroy();
});

function Editor({
  editor,
  contextId,
  children,
}: {
  editor: BlockNoteEditor<any, any, any>;
  contextId: string;
  children?: ReactNode;
}) {
  const source = useMemo(
    () => createPageContentSearchSource(editor, contextId),
    [editor, contextId],
  );
  useRegisterContentSearchSource(source);
  const controller = useContentSearch();
  useLayoutEffect(() => {
    find = controller;
  }, [controller]);
  return (
    <div className="nfm-editor">
      <BlockNoteViewRaw
        editor={editor}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        tableHandles={false}
      />
      {children}
    </div>
  );
}

function makeEditor(suffix: string) {
  const editor = BlockNoteEditor.create({
    schema: nfmSchema,
    extensions: [nfmSearchExtension()],
    initialContent: [
      {
        id: `first-${suffix}`,
        type: "paragraph",
        content: [
          { type: "text", text: "ｍｉ", styles: {} },
          { type: "text", text: "grá", styles: { bold: true } },
          { type: "text", text: "tion", styles: {} },
        ],
      },
      {
        id: `toggle-${suffix}`,
        type: "toggleListItem",
        content: "Details",
        children: [{ id: `second-${suffix}`, type: "paragraph", content: "migration" }],
      },
    ],
  });
  editors.push(editor);
  return editor;
}

async function open(editor: BlockNoteEditor<any, any, any>) {
  await act(async () => {
    editor.focus();
    find.requestOpen();
  });
  const input = await screen.findByRole("textbox", { name: "Search Page" });
  await act(async () => {
    fireEvent.change(input, { target: { value: "migration" } });
  });
  await waitFor(() => expect(getNfmSearchState(editor).totalMatches).toBe(2));
  await waitFor(() => expect(getNfmSearchState(editor).activeIndex).toBe(0));
  return input;
}

async function shortcut(platform: "macOS" | "windows", shiftKey: boolean) {
  await act(async () => {
    expect(
      handleWorkbenchShortcut(
        {
          key: "g",
          code: "KeyG",
          ctrlKey: platform === "windows",
          metaKey: platform === "macOS",
          altKey: false,
          shiftKey,
          target: document.activeElement,
        },
        { projectOrder: [], switchToProjectIndex: () => undefined },
        platform === "macOS",
      ),
    ).toBe(true);
  });
}

test("Page Find matches across formatting, reveals toggles, navigates with Enter and both platform shortcuts, and replaces", async () => {
  const editor = makeEditor("page");
  const view = render(
    <ContentSearchProvider>
      <ContentSearchSurface />
      <Editor editor={editor} contextId="page" />
    </ContentSearchProvider>,
  );
  const input = await open(editor);
  await waitFor(() => expect(input).toHaveFocus());
  expect(view.container.querySelectorAll(".nfm-search-match").length).toBeGreaterThan(1);
  const toggle = view.container.querySelector<HTMLElement>(".bn-toggle-wrapper")!;
  if (toggle.dataset.showChildren === "true")
    fireEvent.click(toggle.querySelector(".bn-toggle-button")!);
  expect(toggle.dataset.showChildren).toBe("false");
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
  await waitFor(() => expect(getNfmSearchState(editor).activeIndex).toBe(1));
  await waitFor(() => expect(toggle.dataset.showChildren).toBe("true"));
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  });
  await waitFor(() => expect(getNfmSearchState(editor).activeIndex).toBe(0));
  expect(input).toHaveFocus();
  for (const platform of ["macOS", "windows"] as const) {
    await shortcut(platform, false);
    await waitFor(() => expect(getNfmSearchState(editor).activeIndex).toBe(1));
    await shortcut(platform, true);
    await waitFor(() => expect(getNfmSearchState(editor).activeIndex).toBe(0));
  }
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Show replace controls" }));
  });
  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Replace text" }), {
      target: { value: "moved" },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Replace current match" }));
  });
  await waitFor(() => expect(getNfmSearchState(editor).totalMatches).toBe(1));
  expect(editor.prosemirrorState.doc.textContent).toContain("moved");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Replace all matches" })).not.toBeDisabled(),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Replace all matches" }));
  });
  await waitFor(() => expect(editor.prosemirrorState.doc.textContent).toBe("movedDetailsmoved"));
  await waitFor(() => expect(find.resultLabel).toBe("No results"));
});

test("Page reveal activates the addressed Block and focused child editors retain one Find", async () => {
  const parent = makeEditor("parent");
  const child = makeEditor("child");
  render(
    <ContentSearchProvider>
      <ContentSearchSurface />
      <Editor editor={parent} contextId="parent">
        <Editor editor={child} contextId="child" />
      </Editor>
    </ContentSearchProvider>,
  );
  await open(parent);
  await open(child);
  await act(async () => {
    find.requestOpen({
      preferredDomain: "page",
      contextId: "child",
      query: "migration",
      pageReveal: { kind: "page-search", blockId: "second-child", text: "migration" },
    });
  });
  await waitFor(() => expect(getNfmSearchState(child).activeIndex).toBe(1));
  await waitFor(() => expect(getNfmSearchState(parent).totalMatches).toBe(0));
  expect(screen.getAllByRole("textbox", { name: "Search Page" })).toHaveLength(1);
  await act(async () => {
    child.updateBlock("second-child", { content: "Changed" });
    find.requestOpen({
      preferredDomain: "page",
      contextId: "child",
      query: "migration",
      pageReveal: { kind: "page-search", blockId: "second-child", text: "migration" },
    });
  });
  await waitFor(() => expect(find.state.loadingDomain).toBeNull());
  await waitFor(() => expect(find.state.activeIndexByDomain.page).toBe(-1));
  expect(getNfmSearchState(child).activeMatch).toBeNull();
  await shortcut("macOS", false);
  await waitFor(() => expect(getNfmSearchState(child).activeIndex).toBe(0));
  await act(async () => {
    find.close();
  });
  await open(parent);
  expect(getNfmSearchState(child).totalMatches).toBe(0);
});

test("Find stays inside a dialog's Page editor and read-only Pages omit Replace", async () => {
  const editor = makeEditor("dialog");
  editor.isEditable = false;
  const view = render(
    <ContentSearchProvider>
      <ContentSearchSurface />
      <div data-slot="codex-dialog-overlay" />
      <div role="dialog" aria-label="Page">
        <Editor editor={editor} contextId="dialog" />
      </div>
    </ContentSearchProvider>,
  );
  await act(async () => {
    find.requestOpen({ preferredDomain: "page", contextId: "dialog", query: "migration" });
  });
  const input = await screen.findByRole("textbox", { name: "Search Page" });
  await waitFor(() => expect(getNfmSearchState(editor).totalMatches).toBe(2));
  expect(input.closest('[role="dialog"]')).toBe(view.getByRole("dialog", { name: "Page" }));
  expect(screen.queryByRole("button", { name: "Show replace controls" })).toBeNull();
});
