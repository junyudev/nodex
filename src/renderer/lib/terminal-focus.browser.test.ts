import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  registerTerminalFocusTarget,
  rememberFocusBeforeTerminal,
  requestTerminalFocus,
  returnFocusFromPanel,
  terminalHoldsFocus,
} from "./terminal-focus";

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

const terminal = (terminalSessionId: string) => ({
  kind: "terminal",
  config: { terminalSessionId },
});

function appendTerminalTab(terminalId: string): HTMLTextAreaElement {
  const surface = document.createElement("div");
  surface.id = `terminal-panel-${terminalId}`;
  surface.dataset.codexTerminal = "true";
  const input = document.createElement("textarea");
  surface.append(input);
  bottomPanel().append(surface);
  return input;
}

function bottomPanel(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(
    '[data-app-shell-focus-area="bottom-panel"]',
  );
  if (existing) return existing;
  const panel = document.createElement("section");
  panel.dataset.appShellFocusArea = "bottom-panel";
  document.body.append(panel);
  return panel;
}

function appendComposer(parent: HTMLElement = document.body): HTMLElement {
  const composer = document.createElement("div");
  composer.contentEditable = "true";
  composer.dataset.codexComposer = "true";
  composer.textContent = "draft";
  parent.append(composer);
  return composer;
}

const unregisterTargets: (() => void)[] = [];

/** Mounts a Terminal the way its view does, returning how many times it was asked to focus. */
function mountTerminal(terminalId: string): { readonly focus: ReturnType<typeof vi.fn> } {
  const focus = vi.fn();
  unregisterTargets.push(registerTerminalFocusTarget(terminalId, focus));
  return { focus };
}

afterEach(() => {
  vi.useRealTimers();
  // Ends any request a test left waiting and forgets what the cursor left.
  returnFocusFromPanel("bottom");
  for (const unregister of unregisterTargets.splice(0)) unregister();
  document.body.replaceChildren();
});

describe("requestTerminalFocus", () => {
  test("focuses a Terminal that is already mounted", () => {
    const { focus } = mountTerminal("terminal-a");

    requestTerminalFocus(terminal("terminal-a"));

    expect(focus).toHaveBeenCalledTimes(1);
  });

  test("waits for the Terminal to mount, then answers once", () => {
    requestTerminalFocus(terminal("terminal-a"));

    const first = mountTerminal("terminal-a");
    expect(first.focus).toHaveBeenCalledTimes(1);

    // The same Terminal mounting again later, such as on a Scene switch, was not asked for.
    const second = mountTerminal("terminal-a");
    expect(second.focus).not.toHaveBeenCalled();
  });

  test("another Terminal mounting does not answer the request", () => {
    requestTerminalFocus(terminal("terminal-a"));

    expect(mountTerminal("terminal-b").focus).not.toHaveBeenCalled();
    expect(mountTerminal("terminal-a").focus).toHaveBeenCalledTimes(1);
  });

  test("ignores a surface that is not a Terminal", () => {
    requestTerminalFocus(terminal("terminal-a"));
    requestTerminalFocus({ kind: "browser", config: { terminalSessionId: "terminal-b" } });
    requestTerminalFocus(null);

    expect(mountTerminal("terminal-b").focus).not.toHaveBeenCalled();
    expect(mountTerminal("terminal-a").focus).toHaveBeenCalledTimes(1);
  });

  test("a pointer press while waiting keeps the cursor where the user put it", () => {
    requestTerminalFocus(terminal("terminal-a"));

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(mountTerminal("terminal-a").focus).not.toHaveBeenCalled();
  });

  test("a newer request replaces the one still waiting", () => {
    requestTerminalFocus(terminal("terminal-a"));
    requestTerminalFocus(terminal("terminal-b"));

    expect(mountTerminal("terminal-a").focus).not.toHaveBeenCalled();
    expect(mountTerminal("terminal-b").focus).toHaveBeenCalledTimes(1);
  });

  test("a request expires rather than moving the cursor long after it was made", () => {
    vi.useFakeTimers();
    requestTerminalFocus(terminal("terminal-a"));
    vi.advanceTimersByTime(999);
    expect(mountTerminal("terminal-a").focus).toHaveBeenCalledTimes(1);

    requestTerminalFocus(terminal("terminal-b"));
    vi.advanceTimersByTime(1_000);
    expect(mountTerminal("terminal-b").focus).not.toHaveBeenCalled();
  });

  test("an open dialog keeps the cursor", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const search = document.createElement("input");
    dialog.append(search);
    document.body.append(dialog);
    search.focus();
    const mounted = mountTerminal("terminal-a");

    requestTerminalFocus(terminal("terminal-a"));
    expect(mounted.focus).not.toHaveBeenCalled();

    requestTerminalFocus(terminal("terminal-b"));
    expect(mountTerminal("terminal-b").focus).not.toHaveBeenCalled();
  });

  test("a Terminal that has unmounted waits for its next mount", () => {
    const stale = vi.fn();
    registerTerminalFocusTarget("terminal-a", stale)();

    requestTerminalFocus(terminal("terminal-a"));

    expect(stale).not.toHaveBeenCalled();
    expect(mountTerminal("terminal-a").focus).toHaveBeenCalledTimes(1);
  });
});

describe("returnFocusFromPanel", () => {
  test("hiding the Terminal returns to the editor the cursor came from", async () => {
    appendComposer();
    const editor = document.createElement("input");
    document.body.append(editor);
    const input = appendTerminalTab("terminal-a");
    editor.focus();
    rememberFocusBeforeTerminal(editor);
    input.focus();

    returnFocusFromPanel("bottom");
    await nextFrame();

    expect(document.activeElement).toBe(editor);
  });

  test("falls back to the composer when the previous editor is gone", async () => {
    const composer = appendComposer();
    const editor = document.createElement("input");
    document.body.append(editor);
    const input = appendTerminalTab("terminal-a");
    rememberFocusBeforeTerminal(editor);
    editor.remove();
    input.focus();

    returnFocusFromPanel("bottom");
    await nextFrame();

    expect(document.activeElement).toBe(composer);
  });

  test("skips a composer the Scene has hidden", async () => {
    const hiddenSection = document.createElement("section");
    hiddenSection.setAttribute("aria-hidden", "true");
    document.body.append(hiddenSection);
    appendComposer(hiddenSection);
    const composer = appendComposer();
    appendTerminalTab("terminal-a").focus();

    returnFocusFromPanel("bottom");
    await nextFrame();

    expect(document.activeElement).toBe(composer);
  });

  test("a cursor outside the hiding panel stays put", async () => {
    appendComposer();
    const editor = document.createElement("input");
    document.body.append(editor);
    appendTerminalTab("terminal-a");
    editor.focus();

    returnFocusFromPanel("bottom");
    await nextFrame();

    expect(document.activeElement).toBe(editor);
  });

  test("a cursor resting on the page moves to the composer", async () => {
    const composer = appendComposer();

    returnFocusFromPanel("bottom");
    await nextFrame();

    expect(document.activeElement).toBe(composer);
  });

  test("cancels a Terminal focus still waiting to mount", async () => {
    const composer = appendComposer();
    requestTerminalFocus(terminal("terminal-a"));

    returnFocusFromPanel("bottom");
    await nextFrame();

    expect(mountTerminal("terminal-a").focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(composer);
  });
});

describe("rememberFocusBeforeTerminal", () => {
  test("ignores controls and other Terminals, which are no place to return to", async () => {
    const composer = appendComposer();
    const button = document.createElement("button");
    button.textContent = "Toggle";
    document.body.append(button);
    const other = appendTerminalTab("terminal-b");
    const input = appendTerminalTab("terminal-a");

    rememberFocusBeforeTerminal(button);
    rememberFocusBeforeTerminal(other);
    rememberFocusBeforeTerminal(null);
    input.focus();
    returnFocusFromPanel("bottom");
    await nextFrame();

    expect(document.activeElement).toBe(composer);
  });
});

describe("terminalHoldsFocus", () => {
  test("reports only the Terminal the cursor is inside", () => {
    const input = appendTerminalTab("terminal-a");
    appendTerminalTab("terminal-b");
    input.focus();

    expect(terminalHoldsFocus("terminal-a")).toBe(true);
    expect(terminalHoldsFocus("terminal-b")).toBe(false);
    expect(terminalHoldsFocus("terminal-missing")).toBe(false);
  });
});
