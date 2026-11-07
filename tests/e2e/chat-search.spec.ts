import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import type { ProjectSession } from "../../src/shared/types";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { invokeIpc, requireIpcValue } from "./support/editor-scenario";
import { waitForDraftScene } from "./support/new-chat-draft";

const CJK_TITLE = "帮我把我的服务器配置一下";
const ENGLISH_TITLE = "Rotate the staging deploy keys";
const primaryShortcut = (key: string): string =>
  `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;

test("finds old chats across the complete catalog with CJK substrings and typos, then opens the Session", async ({}, testInfo) => {
  test.setTimeout(120_000);
  await withElectronScenario(
    {
      label: "chat-search",
      scenarioId: null,
      prepareAgentRuntime: false,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("runtime-logs-at-failure", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        if (!page) return;
        await testInfo.attach("renderer-at-failure", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      },
    },
    async ({ page, profile, seed }) => {
      const firstDirectory = path.join(profile.projectsDirectory, "infrastructure");
      const secondDirectory = path.join(profile.projectsDirectory, "deployments");
      await mkdir(firstDirectory);
      await mkdir(secondDirectory);
      const firstProject = await seed.createProject({
        name: "Infrastructure",
        sources: [firstDirectory],
      });
      const secondProject = await seed.createProject({
        name: "Deployments",
        sources: [secondDirectory],
      });
      const createChat = async (projectId: string | null, title: string) =>
        requireIpcValue<ProjectSession>(
          await invokeIpc(page, "project-sessions:create", {
            operationId: createBoundedOperationId("e2e.chat-search.create-session"),
            payload: {
              sessionId: createUuidV7(),
              input: { projectId, noThreadFallbackTitle: title, initialPageIds: [] },
            },
          }),
          `Create chat ${title}`,
        );

      // Draft conversation recency is its creation time. Public operations create both
      // targets first, followed by enough newer chats to cross the old 100-Session cap.
      const cjkChat = await createChat(firstProject.id, CJK_TITLE);
      const englishChat = await createChat(secondProject.id, ENGLISH_TITLE);
      const newerChats: ProjectSession[] = [];
      for (let index = 0; index < 130; index += 1) {
        const projectId =
          index >= 126 ? null : index % 2 === 0 ? firstProject.id : secondProject.id;
        newerChats.push(
          await createChat(projectId, `Catalog fixture ${String(index + 1).padStart(3, "0")}`),
        );
      }
      const chats = [cjkChat, englishChat, ...newerChats];
      expect(new Set(chats.map((chat) => chat.id)).size).toBe(132);
      expect(chats.every((chat) => !chat.archived && chat.thread === null)).toBe(true);
      expect(chats.filter((chat) => chat.projectId === null)).toHaveLength(4);
      expect(Date.parse(cjkChat.createdAt)).toBeLessThanOrEqual(Date.parse(englishChat.createdAt));
      expect(
        newerChats.filter((chat) => Date.parse(chat.createdAt) > Date.parse(englishChat.createdAt)),
        "Both search targets must be older than at least 100 non-archived chats",
      ).toHaveLength(130);

      await page.setViewportSize({ width: 1280, height: 800 });
      // Reload after public seeding so the palette starts from a fresh renderer.
      await page.reload();
      await expect(
        page.getByRole("button", { name: "New chat", exact: true }).first(),
      ).toBeVisible();
      await page.keyboard.press(primaryShortcut("G"));
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await expect(palette).toBeVisible();
      await expect(palette.getByRole("tab", { name: "Chats", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      const search = palette.getByRole("combobox", { name: "Command palette search" });
      await expect(search).toBeFocused();
      await page.keyboard.insertText("服务器");
      await expect(search).toHaveValue("服务器");
      const cjkResult = palette.getByRole("option", { name: new RegExp(CJK_TITLE) });
      await expect(cjkResult).toBeVisible({ timeout: 5_000 });
      const catalogFailure = palette
        .getByRole("status")
        .filter({ hasText: "Chats couldn’t be searched" });
      await expect(catalogFailure).toHaveCount(0);

      const screenshot = testInfo.outputPath("palette-cjk-result.png");
      await page.screenshot({ path: screenshot });
      await testInfo.attach("palette-cjk-result", { path: screenshot, contentType: "image/png" });

      await search.fill("rotat stagng");
      await expect(palette.getByRole("option", { name: new RegExp(ENGLISH_TITLE) })).toBeVisible({
        timeout: 5_000,
      });
      await expect(catalogFailure).toHaveCount(0);

      await search.fill("");
      await page.keyboard.insertText("服务器");
      await expect(cjkResult).toBeVisible({ timeout: 5_000 });
      await expect(cjkResult).toHaveAttribute("aria-selected", "true");
      await search.press("Enter");
      await expect(palette).toHaveCount(0);
      await waitForDraftScene(page, cjkChat.id);
    },
  );
});
