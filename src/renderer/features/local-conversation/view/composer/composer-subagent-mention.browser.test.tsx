import { act, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { expect, test, vi } from "vite-plus/test";
import { SubagentAvatar } from "../shared/subagent-avatar";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./composer-prompt-editor";
import "../../../../globals.css";

test("restored subagent mentions follow the same identity and document theme as Thread avatars", async () => {
  const root = document.documentElement;
  const originalTheme = root.getAttribute("data-theme");
  const originalClass = root.className;
  root.dataset.theme = "light";
  // The canonical theme attribute, rather than a separate CSS class, selects artwork.
  root.classList.add("dark");
  const value = "Ask [@Scout](agent://child-thread)";
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const onChange = vi.fn();
  const view = render(
    <>
      <SubagentAvatar seed="child-thread" data-testid="thread-avatar" />
      <ComposerPromptEditor
        ref={editorRef}
        value={value}
        placeholder="Ask"
        disabled={false}
        onChange={onChange}
        onKeyDown={() => false}
      />
    </>,
  );
  const visibleMentionImages = () =>
    [...view.container.querySelectorAll<HTMLImageElement>("[data-composer-mention] img")].filter(
      (image) => getComputedStyle(image).display !== "none",
    );
  const threadAvatar = view.getByTestId("thread-avatar") as HTMLImageElement;
  try {
    await waitFor(() => {
      expect(visibleMentionImages()).toHaveLength(1);
      expect(visibleMentionImages()[0]?.src).toBe(threadAvatar.src);
      expect(visibleMentionImages()[0]?.getBoundingClientRect().width).toBe(14);
      expect(visibleMentionImages()[0]?.getBoundingClientRect().height).toBe(14);
    });
    const lightSource = threadAvatar.src;
    await act(async () => {
      root.classList.remove("dark");
      root.dataset.theme = "dark";
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(visibleMentionImages()).toHaveLength(1);
      expect(visibleMentionImages()[0]?.src).toBe(threadAvatar.src);
      expect(threadAvatar.src).not.toBe(lightSource);
    });
    expect(editorRef.current?.getPersistedText()).toBe(value);
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    if (originalTheme === null) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", originalTheme);
    root.className = originalClass;
  }
});
