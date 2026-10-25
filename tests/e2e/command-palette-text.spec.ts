import { expect, test, type Locator } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { BOARD_DENSE_SCENARIO_ID } from "../../scripts/scenarios/scenarios/board-dense";
import { focusBoardDenseUi } from "../../scripts/scenarios/scenarios/board-dense-ui";

const primaryShortcut = (key: string): string =>
  `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;

/** Read the browser's actual caret inside Pierre's shadow tree, without mutating editor state. */
const readEditorCaret = async (editor: Locator) =>
  await editor.evaluate((region) => {
    const roots: ShadowRoot[] = [];
    const collectRoots = (root: ParentNode): void => {
      for (const element of root.querySelectorAll("*")) {
        if (!element.shadowRoot) continue;
        roots.push(element.shadowRoot);
        collectRoots(element.shadowRoot);
      }
    };
    collectRoots(region);
    for (const root of roots) {
      const selection = (
        root as ShadowRoot & { getSelection?: () => Selection | null }
      ).getSelection?.();
      if (!selection?.rangeCount) continue;
      const range = selection.getRangeAt(0);
      const node = range.startContainer;
      const element = node instanceof Element ? node : node.parentElement;
      const line = element?.closest<HTMLElement>("[data-line]");
      if (!line || line.getRootNode() !== root) continue;
      const prefix = document.createRange();
      prefix.selectNodeContents(line);
      prefix.setEnd(node, range.startOffset);
      return {
        line: Number(line.dataset.line),
        column: prefix.toString().length + 1,
        collapsed: range.collapsed,
      };
    }
    return null;
  });

test("searches file contents, filters file types and opens the exact matching caret from Command Palette", async ({}, testInfo) => {
  test.setTimeout(120_000);
  await withElectronScenario(
    {
      label: "command-palette-text",
      scenarioId: BOARD_DENSE_SCENARIO_ID,
      // The production runtime supplies ripgrep; no scripted app-server or search responses.
      cwd: process.cwd(),
      prepareAgentRuntime: false,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("runtime-logs-at-failure", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        if (!page) return;
        await testInfo.attach("renderer-at-failure", {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      },
    },
    async ({ page, profile, manifest }) => {
      if (!manifest) throw new Error("board/dense did not materialize");
      const workspace = path.join(profile.initialProjectsDirectory, "text-search-fixture");
      const targetPath = path.join(workspace, "implementation.ts");
      const excludedPath = path.join(workspace, "notes.md");
      const needle = "CommandPaletteBodyNeedle_7B39";
      const targetLine = 81;
      const prefix = "// 🙂 café ";
      const targetColumn = prefix.length + 1;
      const contents = [
        ...Array.from({ length: targetLine - 1 }, (_, index) => `// Context line ${index + 1}`),
        `${prefix}${needle} is found in file contents.`,
        ...Array.from({ length: 40 }, (_, index) => `// Following line ${index + 1}`),
        "",
      ].join("\n");
      await mkdir(workspace);
      await Promise.all([
        writeFile(targetPath, contents),
        writeFile(excludedPath, `${needle} also appears in Markdown.\n`),
      ]);
      await focusBoardDenseUi(page, manifest);
      const artifacts = testInfo.outputPath("review");
      await mkdir(artifacts, { recursive: true });
      const claims: Array<{ name: string; expected: unknown; actual: unknown }> = [];
      const claim = (name: string, expected: unknown, actual: unknown) => {
        claims.push({ name, expected, actual });
        expect(actual, name).toEqual(expected);
      };
      let status = "failed";
      let failure: string | null = null;
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.screencast.start({
        path: path.join(artifacts, "review.webm"),
        size: { width: 1280, height: 800 },
        annotate: { position: "bottom", fontSize: 14 },
      });
      try {
        await page.keyboard.press(primaryShortcut("K"));
        const palette = page.getByRole("dialog", { name: "Command palette" });
        await expect(palette).toBeVisible();
        await palette.getByRole("tab", { name: "Text", exact: true }).click();
        await palette.getByRole("button", { name: "Search folder", exact: true }).click();
        await page.getByRole("menuitem", { name: "Choose folder", exact: true }).click();
        const folderPicker = page.getByRole("dialog", { name: "Choose search folder" });
        await expect(folderPicker).toBeVisible();
        await folderPicker.getByRole("textbox", { name: "Folder path" }).fill(workspace);
        await folderPicker.getByRole("textbox", { name: "Folder path" }).press("Enter");
        await expect(folderPicker.getByText("No folders", { exact: true })).toBeVisible();
        await folderPicker.getByRole("button", { name: "Choose folder", exact: true }).click();
        await expect(folderPicker).toHaveCount(0);

        const search = palette.locator('input[aria-label="Command palette search"]');
        await expect(search).toBeFocused();
        await search.fill(needle);
        const target = palette.getByRole("option", {
          name: `${targetPath}:${targetLine}`,
          exact: true,
        });
        const excluded = palette.getByRole("option", { name: `${excludedPath}:1`, exact: true });
        await expect(target).toBeVisible({ timeout: 15_000 });
        await expect(excluded).toBeVisible();
        await expect(target.locator("mark")).toHaveText(needle);
        claim(
          "Text finds matching file contents",
          [`${excludedPath}:1`, `${targetPath}:${targetLine}`].sort((left, right) =>
            left.localeCompare(right),
          ),
          await palette
            .getByRole("option")
            .evaluateAll((options) =>
              options
                .map((option) => option.getAttribute("aria-label") ?? "")
                .sort((left, right) => left.localeCompare(right)),
            ),
        );
        await page.screenshot({ path: path.join(artifacts, "palette-search.png") });
        await page.waitForTimeout(600);
        await palette.getByRole("textbox", { name: "File types" }).fill("*.ts");
        await palette.getByRole("textbox", { name: "File types" }).press("Enter");
        await expect(search).toBeFocused();
        await expect(search).toHaveValue(needle);
        await expect(excluded).toHaveCount(0);
        await expect(palette.getByRole("option")).toHaveCount(1);
        await expect(target).toBeEnabled();
        await expect(target).toHaveAttribute("aria-selected", "true");
        claim(
          "File types preserves the query and filters to TypeScript",
          { query: needle, matches: [`${targetPath}:${targetLine}`] },
          {
            query: await search.inputValue(),
            matches: await palette
              .getByRole("option")
              .evaluateAll((options) => options.map((option) => option.getAttribute("aria-label"))),
          },
        );
        await page.screenshot({ path: path.join(artifacts, "palette-filter.png") });
        await page.waitForTimeout(600);
        await search.press("Enter");
        await expect(palette).toHaveCount(0);

        const editor = page.getByRole("region", { name: "Source editor for implementation.ts" });
        await expect(editor).toBeVisible();
        await expect(
          page.locator("[data-workspace-files-tab-id]").filter({ has: editor }),
        ).toHaveAttribute("data-workspace-files-tab-id", `file:local:${targetPath}`);
        const expectedCaret = { line: targetLine, column: targetColumn, collapsed: true };
        await expect.poll(() => readEditorCaret(editor)).toEqual(expectedCaret);
        claim("Enter opens the matching UTF16 caret", expectedCaret, await readEditorCaret(editor));
        await expect(editor.locator('[contenteditable="true"]')).toBeFocused();
        // A saved edit proves the reveal reached the actual editing cursor, including UTF16 columns.
        const insertion = "INSERTED_AT_MATCH_";
        await page.keyboard.insertText(insertion);
        await expect
          .poll(() => readFile(targetPath, "utf8"))
          .toBe(contents.replace(`${prefix}${needle}`, `${prefix}${insertion}${needle}`));
        expect(await readFile(excludedPath, "utf8")).toBe(`${needle} also appears in Markdown.\n`);
        claim(
          "Typing saves at the revealed caret",
          contents.replace(`${prefix}${needle}`, `${prefix}${insertion}${needle}`),
          await readFile(targetPath, "utf8"),
        );
        await page.screenshot({ path: path.join(artifacts, "final.png") });
        await page.waitForTimeout(700);
        status = "passed";
        await testInfo.attach("text-search-caret", {
          body: Buffer.from(
            JSON.stringify({ targetPath, mask: "*.ts", expectedCaret, savedInsertion: insertion }),
          ),
          contentType: "application/json",
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        await page.screencast.stop();
        await writeFile(
          path.join(artifacts, "result.json"),
          JSON.stringify(
            {
              status,
              scenario: "board/dense@3",
              fixture:
                "Fresh disposable Profile, production ripgrep, synthetic TypeScript and Markdown files, no Chat created",
              claims,
              failure,
            },
            null,
            2,
          ) + "\n",
        );
        await writeFile(
          path.join(artifacts, "README.md"),
          `# Command Palette text search\n\nStatus: **${status}**.\n\nA fresh board/dense Profile chooses an explicit folder, finds a marker in TypeScript and Markdown file contents, filters with *.ts, and opens the selected result with Enter. The browser's actual editor caret must reach line ${targetLine}, UTF16 column ${targetColumn}, including the emoji prefix. Typing at that caret must save at the exact matching position on disk.\n\n- review.webm: native Electron interaction recording.\n- final.png: settled file editor.\n- result.json: exact expected and actual claims.\n${failure ? `\nFailure: ${failure}\n` : ""}`,
        );
      }
    },
  );
});
