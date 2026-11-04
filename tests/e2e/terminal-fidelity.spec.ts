import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import type { ElectronApplication } from "playwright";
import type { TerminalDataEvent, TerminalSessionSnapshot } from "../../src/shared/types";

const fixtureScript = path.resolve("tests/e2e/fixtures/terminal-fidelity.mjs");
const pollution = {
  NO_COLOR: "1",
  TERM: "dumb",
  COLORTERM: "",
  PAGER: "cat",
  GIT_PAGER: "cat",
  AGENT: "1",
  CODEX_THREAD_ID: "stale",
  TMUX: "/tmp/x,1,0",
  TERM_PROGRAM: "Agent",
  NODEX_TEST_SURVIVOR: "1",
};
const shell = process.platform === "win32" ? "" : path.basename(userInfo().shell || "sh");
const supportsStartupFixture = ["zsh", "bash", "sh", "dash", "ksh"].includes(shell);
const quote = (argument: string) => "'" + argument.replaceAll("'", "'\"'\"'") + "'";

interface TerminalFixture {
  page: Page;
  application: ElectronApplication;
  toggle: Locator;
  surface: Locator;
  screen: Locator;
  rows: Locator;
  focus: () => Promise<void>;
  enter: (command: string) => Promise<void>;
  run: (behavior: string) => Promise<void>;
  readInput: () => Promise<string>;
  snapshot: () => Promise<TerminalSessionSnapshot | null>;
  sessionId: string;
}

const test = base.extend<{
  userNoColor: boolean;
  startup: { directory: string; environment: NodeJS.ProcessEnv };
  terminal: TerminalFixture;
}>({
  userNoColor: [false, { option: true }],
  startup: async ({ userNoColor }, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), "nodex-terminal-startup-"));
    try {
      const profile =
        shell === "zsh" ? ".zprofile" : shell === "bash" ? ".bash_profile" : ".profile";
      const color = userNoColor ? "export NO_COLOR=user-startup\n" : "";
      await writeFile(
        path.join(directory, profile),
        "export NODEX_TEST_LOGIN=login-only\n" + (shell === "zsh" ? "" : color),
      );
      if (shell === "zsh") {
        await writeFile(
          path.join(directory, ".zshrc"),
          "if [[ -o login ]]; then export NODEX_TEST_SHELL_MODE=login; " +
            "else export NODEX_TEST_SHELL_MODE=interactive; fi\n" +
            color,
        );
      }
      await use({
        directory,
        environment: { ...pollution, [shell === "zsh" ? "ZDOTDIR" : "HOME"]: directory },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  terminal: async ({ startup }, use, testInfo) => {
    await withElectronScenario(
      {
        label: "terminal-fidelity",
        scenarioId: null,
        environment: startup.environment,
        windows: "background",
        onFailure: async ({ page, readRuntimeLogs }) => {
          await testInfo.attach("runtime", {
            body: await readRuntimeLogs(),
            contentType: "text/plain",
          });
          if (page && !page.isClosed()) {
            await testInfo.attach("window", {
              body: await page.screenshot(),
              contentType: "image/png",
            });
          }
        },
      },
      async ({ page, application, readRuntimeLogs }) => {
        await page.getByRole("button", { name: "New chat", exact: true }).first().click();
        const toggle = page.getByRole("button", { name: "Toggle bottom panel", exact: true });
        await toggle.click();
        const surface = page.locator("[data-codex-terminal=true]");
        const screen = surface.locator(".xterm-screen");
        const rows = screen.locator(".xterm-rows");
        const input = page.getByRole("textbox", { name: "Terminal input" });
        await expect(screen).toBeVisible();
        const panelId = await surface.getAttribute("id");
        if (!panelId?.startsWith("terminal-panel-"))
          throw new Error("Terminal panel has no identity");
        const sessionId = panelId.slice("terminal-panel-".length);
        const snapshot = () => readSnapshot(page, sessionId);
        const focus = async () => {
          await screen.click({ position: { x: 32, y: 9 } });
          await expect(input).toBeFocused();
        };
        const enter = async (command: string) => {
          await focus();
          await page.keyboard.insertText(command);
          await page.keyboard.press("Enter");
        };
        const file = path.join(startup.directory, "terminal-stdin.bin");
        await writeFile(file, "");
        const readInput = () => readFile(file, "utf8");
        const run = (behavior: string) =>
          enter([process.execPath, fixtureScript, behavior, file].map(quote).join(" "));
        await expect.poll(async () => (await rows.textContent())?.trim()).not.toBe("");
        await use({
          page,
          application,
          toggle,
          surface,
          screen,
          rows,
          focus,
          enter,
          run,
          readInput,
          snapshot,
          sessionId,
        });
        if (testInfo.status !== testInfo.expectedStatus) {
          await testInfo.attach("runtime", {
            body: await readRuntimeLogs(),
            contentType: "text/plain",
          });
          await testInfo.attach("window", {
            body: await page.screenshot(),
            contentType: "image/png",
          });
        }
      },
    );
  },
});

function readSnapshot(page: Page, sessionId: string): Promise<TerminalSessionSnapshot | null> {
  return page.evaluate(
    async (id) =>
      ((await window.api?.invoke("terminal-session:snapshot", id)) as
        | TerminalSessionSnapshot
        | undefined) ?? null,
    sessionId,
  );
}

function observeLiveOutput(page: Page, sessionId: string) {
  return page.evaluateHandle((id) => {
    const chunks: string[] = [];
    window.api?.on("terminal-data", (payload) => {
      const event = payload as TerminalDataEvent;
      if (event.sessionId === id) chunks.push(event.data);
    });
    return chunks;
  }, sessionId);
}

async function expectPaint(rows: Locator, text: string, foreground: string, background: string) {
  await expect
    .poll(() =>
      rows.evaluate(
        (root, { text, foreground, background }) => {
          const span = [...root.querySelectorAll("span")].find((node) => node.textContent === text);
          if (!span) return null;
          const probe = root.ownerDocument.createElement("span");
          probe.style.color = foreground;
          probe.style.backgroundColor = background;
          root.append(probe);
          try {
            const actual = getComputedStyle(span);
            const expected = getComputedStyle(probe);
            return {
              foreground:
                actual.color === expected.color ? "matches" : [actual.color, expected.color],
              background:
                actual.backgroundColor === expected.backgroundColor
                  ? "matches"
                  : [actual.backgroundColor, expected.backgroundColor],
            };
          } finally {
            probe.remove();
          }
        },
        { text, foreground, background },
      ),
    )
    .toEqual({ foreground: "matches", background: "matches" });
}

const indexedBlue = "var(--color-codex-terminal-ansi-blue)";
const indexedGreen = "var(--color-codex-terminal-ansi-green)";

async function reopen(toggle: Locator, screen: Locator) {
  await toggle.click();
  await expect(screen).toHaveCount(0);
  await toggle.click();
  await expect(screen).toBeVisible();
}

async function expectEnvironment(
  terminal: { run: (name: string) => Promise<void>; readInput: () => Promise<string> },
  noColor: string | null,
) {
  await terminal.run("environment");
  await expect
    .poll(async () => JSON.parse((await terminal.readInput()) || "null"))
    .toEqual({
      NO_COLOR: noColor,
      TERM: "xterm-256color",
      COLORTERM: null,
      PAGER: null,
      GIT_PAGER: null,
      AGENT: null,
      CODEX_THREAD_ID: null,
      TMUX: null,
      TERM_PROGRAM: null,
      NODEX_TEST_SURVIVOR: "1",
      NODEX_TEST_LOGIN: "login-only",
      NODEX_TEST_SHELL_MODE: shell === "zsh" ? "interactive" : null,
    });
}

test.describe("Terminal fidelity", () => {
  test.skip(
    !["darwin", "linux", "freebsd", "openbsd", "aix", "sunos"].includes(process.platform),
    "The fixtures exercise a POSIX login shell and PTY raw mode",
  );
  test.skip(!supportsStartupFixture, "The account shell has no supported isolated startup fixture");
  test.describe.configure({ timeout: 90_000 });

  test.describe("Environment", () => {
    test("sanitizes the launcher environment and imports login-only exports", async ({
      terminal,
    }) => {
      await expectEnvironment(terminal, null);
    });

    test.describe("user colour policy", () => {
      test.use({ userNoColor: true });

      test("preserves NO_COLOR from user startup files", async ({ terminal }) => {
        await expectEnvironment(terminal, "user-startup");
      });
    });
  });

  test("enables environment-sensitive colour and paints indexed and truecolor SGR", async ({
    terminal,
  }) => {
    await terminal.run("color");
    await expect(terminal.rows).toContainText("colors=enabled");
    await expectPaint(terminal.rows, "INDEXED", indexedBlue, indexedGreen);
    await expectPaint(terminal.rows, "TRUECOLOR", "rgb(17, 123, 231)", "rgb(80, 18, 40)");
  });

  test("keeps the cursor column across a raw line feed", async ({ terminal }, testInfo) => {
    await terminal.run("lf");
    const bytes = "\x1b[3;10HX\nY";
    await expect.poll(async () => (await terminal.snapshot())?.buffer).toContain(bytes);
    await testInfo.attach("raw-lf-pty-bytes", {
      body: bytes,
      contentType: "application/octet-stream",
    });
    await expect
      .poll(() =>
        terminal.rows.evaluate((root) => {
          const lines = [...root.children].map((line) => line.textContent ?? "");
          return [lines[2]?.indexOf("X"), lines[3]?.indexOf("Y")];
        }),
      )
      .toEqual([9, 10]);
  });

  test("restores alternate-screen colour and repaints on reopen without replying to replay", async ({
    terminal,
  }, testInfo) => {
    const { page, rows, surface, screen, run, toggle, focus, readInput, snapshot, sessionId } =
      terminal;
    const traffic = await observeLiveOutput(page, sessionId);
    const originalReplies = "\x1b[3;10R\x1b[?1;2c";
    try {
      await run("alternate");
      await expect.poll(readInput).toBe(originalReplies);
      await expectPaint(rows, "ALTERNATE CONTENT", indexedBlue, indexedGreen);
      const initial = await snapshot();
      expect(initial?.truncated).toBe(true);
      expect(initial?.buffer).not.toContain("\x1b[?1049h");
      expect(initial?.buffer).toContain("\x1b[6n\x1b[c");
      const frame = () =>
        rows.evaluate((root) => {
          const draw = root.textContent?.match(/REDRAWS=(\d+) SIZE=(\d+x\d+)/);
          if (!draw) return null;
          return { redraws: Number(draw[1]), size: draw[2] };
        });
      const beforeHide = await frame();
      if (!beforeHide) throw new Error("Initial alternate frame was unavailable");
      const start = (await traffic.jsonValue()).length;
      await reopen(toggle, screen);
      // Check the PTY's actual SIGWINCH output, including a repaint that may be immediately
      // followed by another layout resize before Chromium paints that intermediate frame.
      await expect
        .poll(async () => {
          const live = (await traffic.jsonValue()).slice(start).join("");
          return [...live.matchAll(/REDRAWS=(\d+) SIZE=(\d+x\d+)/g)]
            .filter((match) => Number(match[1]) > beforeHide.redraws)
            .map((match) => match[2]);
        })
        .toContain(beforeHide.size);
      await expectPaint(rows, "ALTERNATE CONTENT", indexedBlue, indexedGreen);
      expect(await readInput()).toBe(originalReplies);

      const tab = page
        .locator('[data-panel-tab-row^="bottom:"]')
        .getByRole("tab", { selected: true });
      const originalTabId = await tab.getAttribute("id");
      if (!originalTabId) throw new Error("The selected terminal tab has no identity");
      const originalSurface = page.locator(
        `[id=${JSON.stringify(await surface.getAttribute("id"))}]`,
      );
      const beforeTabSwitch = await frame();
      if (!beforeTabSwitch) throw new Error("Reopened alternate frame was unavailable");
      if (process.platform === "darwin") {
        await focus();
        await page.keyboard.press("Meta+t");
      } else {
        await page.getByRole("button", { name: "New tab", exact: true }).last().click();
      }
      await expect(originalSurface).toHaveCount(0);
      await page.locator(`[id=${JSON.stringify(originalTabId)}]`).click();
      await expect(originalSurface).toBeVisible();
      await expect
        .poll(async () => (await frame())?.redraws ?? -1)
        .toBeGreaterThan(beforeTabSwitch.redraws);
      await expectPaint(rows, "ALTERNATE CONTENT", indexedBlue, indexedGreen);

      // The padded replay would expose a vertical scrollbar if it landed in the normal buffer.
      // Hover reveals an available scrollbar without generating application input.
      await screen.hover();
      await expect(surface.locator(".xterm-scrollable-element > .scrollbar.vertical")).toHaveCSS(
        "opacity",
        "0",
      );
      expect(await readInput()).toBe(originalReplies);
    } finally {
      await testInfo.attach("alternate-stdin", {
        body: await readInput().catch(() => ""),
        contentType: "application/octet-stream",
      });
      const state = await snapshot();
      await testInfo.attach("alternate-live-redraws", {
        body: [...(await traffic.jsonValue()).join("").matchAll(/REDRAWS=\d+ SIZE=\d+x\d+/g)]
          .map((match) => match[0])
          .join("\n"),
        contentType: "text/plain",
      });
      await traffic.dispose();
      await testInfo.attach("alternate-replay-tail", {
        body: state?.buffer ?? "",
        contentType: "text/plain",
      });
    }
  });

  test("clears the focused Terminal and keeps Meta+K available outside it", async ({
    terminal,
  }) => {
    test.skip(process.platform !== "darwin", "This case exercises the macOS Meta+K shortcut");
    const { page, run, rows, toggle, screen, focus } = terminal;
    await run("clear");
    await expect(rows).toContainText("BEFORE-CLEAR");
    await focus();
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await page.keyboard.press("Meta+k");
    await expect(rows).not.toContainText("BEFORE-CLEAR");
    await expect(palette).toHaveCount(0);
    await reopen(toggle, screen);
    await focus();
    await page.keyboard.insertText("!");
    await expect(rows).toContainText("AFTER-CLEAR");
    await expect(rows).not.toContainText("BEFORE-CLEAR");
    const composer = page.locator('[contenteditable="true"][aria-label="Do anything"]');
    await composer.click();
    await page.keyboard.press("Meta+k");
    await expect(palette).toBeVisible();
  });

  test("brackets a multiline paste and copies a selection through clipboard events", async ({
    terminal,
  }) => {
    const { application, page, run, rows, screen, readInput } = terminal;
    await run("paste");
    const copyText = "TERMINAL-COPY-SELECTION";
    await expect(rows).toContainText(copyText);

    // The Edit menu delivers these events on macOS, where the Terminal leaves Cmd+C and Cmd+V to it.
    const editRoles = await application.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        ?.items.find((item) => item.role?.toLowerCase() === "editmenu" || item.label === "Edit")
        ?.submenu?.items.map((item) => item.role),
    );
    expect(editRoles).toEqual(expect.arrayContaining(["copy", "paste"]));

    const textarea = page.locator(".xterm-helper-textarea");
    await textarea.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "first line\nsecond line");
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    });
    await expect.poll(readInput).toBe("\x1b[200~first line\rsecond line\x1b[201~");
    await expect(rows.locator(":scope > div").first()).toContainText(copyText);

    await screen.click({ position: { x: 32, y: 9 }, clickCount: 3 });
    const copied = await textarea.evaluate((element) => {
      const clipboardData = new DataTransfer();
      element.dispatchEvent(
        new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }),
      );
      return clipboardData.getData("text/plain");
    });
    expect(copied).toBe(copyText);
  });

  test("delivers a 4 MB burst in order through the live rows and replay tail and still accepts input", async ({
    terminal,
  }, testInfo) => {
    const { page, sessionId, run, rows, toggle, screen, snapshot, focus } = terminal;
    const traffic = await observeLiveOutput(page, sessionId);
    const readNumbers = (value: string) =>
      [...value.matchAll(/BURST (\d{6}) x{35}/g)].map((match) => Number(match[1]));
    const expectContiguousTail = (numbers: number[], minimum: number) => {
      expect(numbers.length).toBeGreaterThanOrEqual(minimum);
      expect(numbers.at(-1)).toBe(80_000);
      expect(numbers.every((number, index) => number === 80_001 - numbers.length + index)).toBe(
        true,
      );
    };
    try {
      await run("load");
      await expect(rows).toContainText("BURST-DONE", { timeout: 30_000 });
      const all = readNumbers((await traffic.jsonValue()).join(""));
      expect(all).toHaveLength(80_000);
      expectContiguousTail(all, 80_000);
      expectContiguousTail(readNumbers((await rows.textContent()) ?? ""), 3);
      const state = await snapshot();
      expect(state?.truncated).toBe(true);
      expect(state?.buffer.length).toBeLessThanOrEqual(16_000);
      expectContiguousTail(readNumbers(state?.buffer ?? ""), 300);
      await reopen(toggle, screen);
      await expect(rows).toContainText("BURST-DONE");
      expectContiguousTail(readNumbers((await rows.textContent()) ?? ""), 3);
      await focus();
      await page.keyboard.insertText("!");
      await expect(rows).toContainText("INPUT-ACCEPTED");
    } finally {
      await testInfo.attach("load-summary", {
        body: JSON.stringify({
          liveNumberedLines: readNumbers((await traffic.jsonValue()).join("")).length,
          visibleRows: await rows.textContent(),
          replayTail: (await snapshot())?.buffer,
        }),
        contentType: "application/json",
      });
      await traffic.dispose();
    }
  });

  test("uses an OSC title and falls back to the folder for a cwd title", async ({ terminal }) => {
    const { page, run, focus, snapshot } = terminal;
    const cwd = (await snapshot())?.cwd;
    if (!cwd) throw new Error("The terminal has no working directory");
    await run("title");
    await expect(page.getByRole("tab", { name: "hello-title", exact: true })).toBeVisible();
    await focus();
    await page.keyboard.insertText("!");
    await expect(page.getByRole("tab", { name: "hello-title", exact: true })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: path.basename(cwd), exact: true })).toBeVisible();
  });

  test("retires an exited shell and opens a working new Terminal", async ({ terminal }) => {
    const { page, enter, toggle, surface, rows, snapshot } = terminal;
    const oldId = await surface.getAttribute("id");
    await enter("exit 0");
    await expect.poll(snapshot).toMatchObject({
      exited: true,
      exitCode: 0,
      osPid: null,
      viewLease: null,
    });
    await expect(page.locator(`[id=${JSON.stringify(oldId)}]`)).toHaveCount(0);
    if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
    await toggle.click();
    await expect(surface).toBeVisible();
    expect(await surface.getAttribute("id")).not.toBe(oldId);
    await enter("printf 'NEW-TERMINAL-%s\\n' WORKS");
    await expect(rows).toContainText("NEW-TERMINAL-WORKS");
  });
});
