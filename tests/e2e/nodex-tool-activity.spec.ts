import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  anthropicToolResult,
  startScriptedAnthropicServer,
  type AnthropicRequest,
} from "../../scripts/scenarios/runtime/scripted-anthropic-server";
import {
  createAgentSmokeDraft,
  invokeIpc,
  sendAgentPrompt,
  waitForFinalMarker,
} from "./support/agent-smoke-harness";
import { chooseComposerModel, refreshComposerModels } from "./support/composer-model-picker";

const evidenceRoot = process.env.NODEX_TOOL_ACTIVITY_EVIDENCE_DIR;
const FINAL_MARKER = "TOOL_ACTIVITY_DONE";

const saveEvidence = async (page: Page, name: string, element = page.locator("body")) => {
  const file = test.info().outputPath(`${name}.png`);
  await element.screenshot({ path: file });
  await test.info().attach(name, { path: file, contentType: "image/png" });
  if (!evidenceRoot) return;
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.copyFileSync(file, path.join(evidenceRoot, `${name}.png`));
};

type ToolStep = {
  readonly id: string;
  readonly tool: string;
  readonly input: (pages: Readonly<Record<string, string>>) => Record<string, unknown>;
};

const MISSING_PAGE_ID = "019f0000-0000-7000-8000-000000000000";
const LIBRARY_SCOPE = {};

/** One conversation that exercises the Agent's Page, Database, chat and account tools. */
const STEPS: readonly ToolStep[] = [
  {
    id: "create_plan",
    tool: "create_pages",
    input: () => ({
      destination: { kind: "library" },
      pages: [
        {
          title: "Launch plan",
          markdown: "## Goals\nShip the beta to design partners.\n\n## Owner\nOwner: TBD\n",
        },
      ],
    }),
  },
  {
    id: "create_children",
    tool: "create_pages",
    input: ({ plan }) => ({
      destination: { kind: "page", pageId: plan },
      pages: [{ title: "Launch checklist" }, { title: "Launch FAQ" }, { title: "Launch retro" }],
    }),
  },
  { id: "read_plan", tool: "fetch", input: ({ plan }) => ({ id: plan }) },
  { id: "read_checklist", tool: "fetch", input: ({ checklist }) => ({ id: checklist }) },
  { id: "read_missing", tool: "fetch", input: () => ({ id: MISSING_PAGE_ID }) },
  { id: "search", tool: "search", input: () => ({ query: "Launch" }) },
  {
    id: "update_plan",
    tool: "update_page",
    input: ({ plan }) => ({
      pageId: plan,
      body: {
        kind: "patch",
        patches: [{ oldMarkdown: "Owner: TBD", newMarkdown: "Owner: Ada\nReviewer: Grace" }],
      },
    }),
  },
  {
    id: "duplicate_plan",
    tool: "duplicate_page",
    input: ({ plan }) => ({ pageId: plan, destination: { kind: "library" } }),
  },
  {
    id: "move_faq",
    tool: "move_pages",
    input: ({ faq }) => ({ pageIds: [faq], destination: { kind: "library" } }),
  },
  { id: "context", tool: "get_context", input: () => ({}) },
  { id: "projects", tool: "list_projects", input: () => ({}) },
  { id: "schema", tool: "describe_content_schema", input: () => ({ scope: LIBRARY_SCOPE }) },
  {
    id: "sql",
    tool: "query_content",
    input: () => ({ scope: LIBRARY_SCOPE, sql: "SELECT count(*) AS pages FROM pages" }),
  },
  { id: "chats", tool: "list_sessions", input: () => ({}) },
  { id: "read_chat", tool: "read_session", input: ({ chat }) => ({ sessionId: chat }) },
  { id: "usage", tool: "get_usage_limits", input: () => ({}) },
  {
    id: "inbox",
    tool: "send_to_inbox",
    input: () => ({ title: "Review the launch plan", body: "Check owners before Friday." }),
  },
];

const readToolData = (result: ReturnType<typeof anthropicToolResult>): Record<string, unknown> => {
  const content = result?.content;
  const text =
    typeof content === "string"
      ? content
      : ((content as ReadonlyArray<{ readonly text?: string }> | undefined)?.[0]?.text ?? "{}");
  return (JSON.parse(text) as { data?: Record<string, unknown> }).data ?? {};
};

/** Disclosures and panels animate; review evidence shows them at rest. */
const settle = async (page: Page) => await page.waitForTimeout(600);

const backgroundTitleResponse = (request: AnthropicRequest) => {
  const asksForTitle = request.messages.some(
    (message) =>
      typeof message.content === "string" &&
      message.content.includes("provide a short title for a task"),
  );
  if (!asksForTitle) return undefined;
  return anthropicToolResult(request, "background_title")
    ? { type: "text" as const, text: "Title complete" }
    : {
        type: "tool_use" as const,
        id: "background_title",
        name: "StructuredOutput",
        input: { title: "Prepare the launch plan", description: "Prepare the launch plan" },
      };
};

test("Agent tool rows name what they touched in plain language", async () => {
  test.setTimeout(240_000);
  const pages: Record<string, string> = {};
  let nextStep = 0;
  const server = await startScriptedAnthropicServer(async (request) => {
    const background = backgroundTitleResponse(request);
    if (background) return background;
    if (nextStep > 0) {
      const previous = STEPS[nextStep - 1]!;
      const result = anthropicToolResult(request, previous.id);
      if (previous.id === "create_plan") {
        const created = readToolData(result).pages as ReadonlyArray<{ pageId: string }>;
        pages.plan = created[0]!.pageId;
      }
      if (previous.id === "create_children") {
        const created = readToolData(result).pages as ReadonlyArray<{ pageId: string }>;
        pages.checklist = created[0]!.pageId;
        pages.faq = created[1]!.pageId;
      }
      if (previous.id === "chats") {
        const { sessions } = JSON.parse(String(result?.content)) as {
          sessions: ReadonlyArray<{ sessionId: string }>;
        };
        pages.chat = sessions[0]!.sessionId;
      }
    }
    const step = STEPS[nextStep];
    if (!step) return { type: "text", text: FINAL_MARKER };
    nextStep += 1;
    return {
      type: "tool_use",
      id: step.id,
      name: `mcp__nodex_app__${step.tool}`,
      input: step.input(pages),
    };
  });
  const harness = await ElectronScenarioHarness.create({
    label: "nodex-tool-activity",
    retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
    prepareAgentRuntime: false,
    environment: server.environment,
  });
  try {
    const page = await harness.launch();
    await invokeIpc(page, "settings:claude-agents:update", {
      instances: [
        {
          id: "claude-default",
          displayName: "Claude Code",
          binaryPath: createRequire(
            createRequire(path.join(process.cwd(), "package.json")).resolve(
              "@anthropic-ai/claude-agent-sdk",
            ),
          ).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`),
          configDirectory: harness.profile.claudeConfigHome,
          enabled: true,
          environment: Object.entries(server.environment).map(([name, value]) => ({
            name,
            value,
            sensitive: false,
          })),
        },
      ],
    });
    const draft = await createAgentSmokeDraft(
      page,
      harness.profile.initialProjectsDirectory,
      "Launch workspace",
    );
    await refreshComposerModels(page);
    await chooseComposerModel(page, "Claude Sonnet 5.5", "Claude Sonnet 5.5");
    await page.keyboard.press("Escape");
    if (
      (await page
        .getByRole("button", { name: "Permissions: Full access", exact: true })
        .count()) === 0
    ) {
      await page.getByRole("button", { name: /^Permissions:/ }).click();
      await page.getByRole("menuitem", { name: /Full access/ }).click();
      await page.getByRole("button", { name: "Turn on", exact: true }).click();
    }
    await sendAgentPrompt(page, draft.projectSessionId, "Prepare the launch plan.");
    await waitForFinalMarker(page, FINAL_MARKER, 90_000);
    await page.getByRole("button", { name: /^Worked for/ }).click();
    const groupHeader = page.getByRole("button", { name: /^Created/ });
    await expect(groupHeader).toBeVisible();
    // Two reads settle into one clause, and nothing in the summary is an identity.
    await expect(groupHeader).toContainText("read 2 pages");
    await saveEvidence(page, "01-group-collapsed");
    await groupHeader.click();
    const readRow = page.getByRole("button", { name: "Read Launch plan", exact: true });
    await expect(readRow).toBeVisible();
    await saveEvidence(page, "02-group-open");

    // Review evidence only: lift the group's height bound so every row fits one screenshot.
    const unbound = await page.addStyleTag({
      content:
        ".vertical-scroll-fade-mask { max-height: none !important; mask-image: none !important; }",
    });
    const rows = readRow.locator(
      "xpath=ancestor::div[contains(@class,'vertical-scroll-fade-mask')]",
    );
    const rowsText = (await rows.innerText()).replace(/\s+/gu, " ");
    expect(rowsText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
    expect(rowsText).not.toContain("as markdown");
    expect(rowsText).toContain("Read Launch checklist");
    expect(rowsText).toContain("Couldn't read page");
    expect(rowsText).toMatch(/Searched pages for “Launch” · \d+ results/u);
    expect(rowsText).toContain("Moved Launch FAQ to Library");
    expect(rowsText).toContain("Listed projects");
    expect(rowsText).toContain("Read chat Prepare the launch plan.");
    expect(rowsText).toContain("Couldn't check usage limits");
    expect(rowsText).toContain("Sent to Inbox “Review the launch plan”");
    await saveEvidence(page, "03-group-open-all-rows");

    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(300);
    await saveEvidence(page, "04-all-rows-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await unbound.evaluate((element) => (element as HTMLElement).remove());

    // A row's name is its own link, so the disclosure is toggled from the leading icon and verb.
    const toggle = async (row: Locator) => await row.click({ position: { x: 6, y: 8 } });

    // Opening a row shows what a person reads: the Page as a document, no JSON or identity.
    await toggle(readRow);
    await expect(page.getByRole("heading", { name: "Goals" })).toBeVisible();
    await expect(page.getByText("Ship the beta to design partners.").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Launch checklist" }).first()).toBeVisible();
    expect(await rows.innerText()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
    await settle(page);
    await saveEvidence(page, "05-read-opened");
    await toggle(readRow);

    const searchRow = page.getByRole("button", { name: /^Searched pages for/ });
    await toggle(searchRow);
    await expect(page.locator("[data-nodex-tool-related-pages]")).toContainText("Launch checklist");
    await settle(page);
    await saveEvidence(page, "06-search-opened");
    await toggle(searchRow);

    const updateRow = page.getByRole("button", { name: "Updated Launch plan", exact: true });
    await toggle(updateRow);
    await expect(page.getByText("1 edit", { exact: true })).toBeVisible();
    await expect(page.getByText("Reviewer: Grace").first()).toBeInViewport();
    await settle(page);
    await saveEvidence(page, "07-update-opened");
    await toggle(updateRow);

    const failedRow = page.getByRole("button", { name: "Couldn't read page", exact: true });
    await toggle(failedRow);
    await expect(rows).toContainText("Page or Block was not found");
    await expect(rows).not.toContainText('"code"');
    expect(await rows.innerText()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
    await settle(page);
    await saveEvidence(page, "09-failure-opened");
    await toggle(failedRow);

    // A row with nothing to read does not open; its exact call is still one hover away.
    const listedRow = page.getByText("Listed projects", { exact: true });
    await listedRow.scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Listed projects", exact: true })).toHaveCount(0);
    await listedRow.hover();
    const inspector = listedRow
      .locator("xpath=ancestor::*[contains(@class,'group/activity-header')][1]")
      .getByRole("button", { name: "Inspect tool call" });
    await expect(inspector).toHaveCSS("opacity", "1");
    await settle(page);
    await saveEvidence(page, "10-hover-inspector");

    await inspector.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("nodex_app.list_projects");
    await expect(dialog).toContainText("Completed");
    await expect(dialog.getByRole("tab", { name: "Output" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(dialog).toContainText("Launch workspace");
    await settle(page);
    await saveEvidence(page, "11-inspector-output");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // A read's inspector holds what its opened row leaves out.
    await readRow.hover({ position: { x: 6, y: 8 } });
    await settle(page);
    await saveEvidence(page, "11b-hover-expandable");
    await readRow
      .locator("xpath=ancestor::*[contains(@class,'group/activity-header')][1]")
      .getByRole("button", { name: "Inspect tool call" })
      .click();
    await dialog.getByRole("tab", { name: "Input" }).click();
    await expect(dialog).toContainText('"id"');
    await settle(page);
    await saveEvidence(page, "12-inspector-input");
    await dialog.getByRole("tab", { name: "Raw" }).click();
    await expect(dialog).toContainText("dynamicToolCall");
    await settle(page);
    await saveEvidence(page, "13-inspector-raw");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.getByRole("link", { name: "Launch checklist" }).first().click();
    await expect(
      page.locator('[contenteditable="true"]').filter({ hasText: "Launch checklist" }).first(),
    ).toBeVisible();
    await settle(page);
    await saveEvidence(page, "08-page-opened-beside-chat");
  } finally {
    await harness.close();
    await server.close();
  }
});
