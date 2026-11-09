import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { withCoreScenario } from "../../scripts/scenarios/harness/core-scenario-harness";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../scripts/scenarios/scenarios/document-sync-recovery";
import { createTcpFaultProxy } from "../../scripts/testing/tcp-fault-proxy";
import { CoreClient } from "../../src/main/core-client/core-client";
import { LocalHttpTransport } from "../../src/main/core-client/local-http";
import { readCoreRuntimeConnection } from "../../src/main/core-client/runtime-descriptor";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import type { components } from "@nodex/core-protocol";
import {
  compilePageLifecycleRequestV2,
  type PageLifecyclePreflightSnapshotV2,
} from "../../src/shared/page-lifecycle-v2-runtime";
import { invokeIpc, requireIpcValue } from "./support/editor-scenario";
import { openBoardPageFromCard } from "./support/open-board-page";
import { openProjectBoard } from "../../scripts/scenarios/harness/project-board-ui";

// Each desktop owns its own Profile, device credential, TLS proxy and renderer graph.
test("two Member desktops recover from disconnect and committed response loss, then isolate revocation", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const screenshots =
    process.env.NODEX_TEAM_FAULT_SCREENSHOTS ?? testInfo.outputPath("screenshots");
  await mkdir(screenshots, { recursive: true });
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (scenario) => {
    const host = await CoreClient.connect({
      nodexHome: scenario.profile.nodexHome,
      clientKind: "electron_host",
      buildId: "two-desktop-faults",
    });
    const runtime = readCoreRuntimeConnection(scenario.profile.nodexHome);
    const admin = new LocalHttpTransport(runtime.descriptor.endpoint, runtime.authCapability);
    const listener = await host.listenSpace({ address: "127.0.0.1:0", cert: null, key: null });
    const aliceProxy = await createTcpFaultProxy(listener.url);
    const bobProxy = await createTcpFaultProxy(listener.url);
    const join = async (page: Page, name: string, url: string, role: "owner" | "member") => {
      const invite = await admin.requestJson<components["schemas"]["InviteResponse"]>(
        "POST",
        "/core/v1/admin/space/invite",
        { role },
      );
      await page.getByRole("button", { name: "Switch Space", exact: true }).click();
      await page.getByRole("menuitem", { name: "Join a Space…", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Join a Space" });
      await dialog.getByLabel("Invite URL").fill(`${url}?fingerprint=${listener.fingerprint}`);
      await dialog.getByLabel("One-time code").fill(invite.code);
      await dialog.getByLabel("Your name").fill(name);
      await dialog.getByRole("button", { name: "Join", exact: true }).click();
      await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("spaceId=");
      await expect(
        page.getByRole("button", { name: "Open Document Recovery", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Open Document Recovery", exact: true }).click();
      await openProjectBoard(page);
      return (await invokeIpc(page, "spaces:list")).find((space) => space.kind === "team")!;
    };
    try {
      await withElectronScenario(
        {
          label: "fault-alice",
          scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID,
          seedThrough: "core",
        },
        async (alice) => {
          const aliceTeam = await join(alice.page, "Alice", aliceProxy.url, "owner");
          await withElectronScenario(
            {
              label: "fault-bob",
              scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID,
              seedThrough: "core",
            },
            async (bob) => {
              const bobTeam = await join(bob.page, "Bob", bobProxy.url, "member");
              expect(aliceTeam.memberId).not.toBe(bobTeam.memberId);
              const pageId = createUuidV7();
              const preflight = requireIpcValue<PageLifecyclePreflightSnapshotV2>(
                await invokeIpc(
                  bob.page,
                  "pages:lifecycle:preflight",
                  scenario.manifest.projectId,
                  pageId,
                ),
                "Preflight Bob's Page",
              );
              const request = compilePageLifecycleRequestV2({
                intent: {
                  kind: "create",
                  operationId: createBoundedOperationId("fault-desktop-create"),
                  projectId: scenario.manifest.projectId,
                  pageId,
                  status: "triage",
                  input: {
                    id: pageId,
                    title: "Bob's single Page",
                    description: "Written while Alice was offline",
                  },
                },
                preflight,
              });
              // Idle Alice goes offline before Bob's write. Bob loses the response after commit.
              aliceProxy.setOnline(false);
              await expect
                .poll(
                  async () =>
                    (await invokeIpc(alice.page, "spaces:list")).find(
                      (space) => space.kind === "team",
                    )?.availability,
                )
                .toBe("reconnecting");
              await expect(
                alice.page.getByRole("status").filter({ hasText: "Reconnecting" }),
              ).toBeVisible();
              await alice.page.screenshot({
                path: path.join(screenshots, "01-alice-reconnecting.png"),
              });
              bobProxy.pauseResponses(true);
              const write = invokeIpc(
                bob.page,
                "pages:lifecycle:apply",
                scenario.manifest.projectId,
                request,
              ).then(
                (value) => ({ value }),
                (error) => ({ error }),
              );
              await expect
                .poll(async () => {
                  const detail = await host
                    .libraryRead({ kind: "page_detail", page_id: pageId })
                    .catch((error) => {
                      if (error.coreError?.code === "not_found") return null;
                      throw error;
                    });
                  return detail?.value.kind === "page_detail"
                    ? (detail.value.value.page as { title: string }).title
                    : null;
                })
                .toBe("Bob's single Page");
              bobProxy.disconnect();
              bobProxy.pauseResponses(false);
              const written = await write;
              if (!("value" in written)) throw written.error;
              requireIpcValue(written.value, "Create Bob’s single Page");
              const bobCard = bob.page.locator(`[data-board-uuid-v7="${pageId}"]:visible`);
              await expect(bobCard).toBeVisible();
              await openBoardPageFromCard({
                card: bobCard,
                page: bob.page,
                tabName: "Bob's single Page",
              });
              const editor = (page: Page) =>
                page
                  .locator(
                    `[data-page-stage-page-id="${pageId}"]:visible .ProseMirror[contenteditable="true"]`,
                  )
                  .first();
              await editor(bob.page).click();
              await bob.page.keyboard.press("ControlOrMeta+End");
              await bob.page.keyboard.type(" Bob edited while Alice was offline.");
              await expect
                .poll(
                  async () => {
                    const draft = await host.libraryRead({
                      kind: "page_draft_projection",
                      page_id: pageId,
                    });
                    return draft.value.kind === "page_draft_projection"
                      ? draft.value.value.body_markdown
                      : "";
                  },
                  { timeout: 20_000 },
                )
                .toContain("Bob edited while Alice was offline.");
              aliceProxy.setOnline(true);
              await expect
                .poll(
                  async () =>
                    (await invokeIpc(alice.page, "spaces:list")).find(
                      (space) => space.kind === "team",
                    )?.availability,
                  { timeout: 30_000 },
                )
                .toBe("ready");
              await expect(
                alice.page.getByRole("status").filter({ hasText: "Reconnecting" }),
              ).toHaveCount(0);
              const card = (page: Page) => page.locator(`[data-board-uuid-v7="${pageId}"]:visible`);
              await expect(card(alice.page)).toHaveCount(1);
              await openBoardPageFromCard({
                card: card(alice.page),
                page: alice.page,
                tabName: "Bob's single Page",
              });
              await expect(editor(alice.page)).toContainText("Bob edited while Alice was offline.");
              await alice.page.screenshot({
                path: path.join(screenshots, "02-alice-converged.png"),
              });
              await bob.page.screenshot({ path: path.join(screenshots, "03-bob-converged.png") });
              const devices = await admin.requestJson<components["schemas"]["MemberDevice"][]>(
                "GET",
                "/core/v1/admin/space/devices",
              );
              const bobDevice = devices.find((device) => device.member_id === bobTeam.memberId)!;
              await admin.requestJson("POST", "/core/v1/admin/space/revoke", {
                device_id: bobDevice.id,
              });
              await expect(
                bob.page.getByRole("status").filter({ hasText: "Access revoked" }),
              ).toBeVisible({ timeout: 20_000 });
              await bob.page.screenshot({ path: path.join(screenshots, "04-bob-revoked.png") });
              expect(
                (await invokeIpc(alice.page, "spaces:list")).find((space) => space.kind === "team")
                  ?.availability,
              ).toBe("ready");
              const personal = (await invokeIpc(bob.page, "spaces:list")).find(
                (space) => space.kind === "personal",
              )!;
              await bob.page.getByRole("button", { name: "Switch Space", exact: true }).click();
              await bob.page.getByRole("menuitem").filter({ hasText: personal.name }).click();
              await expect
                .poll(async () => (await invokeIpc(bob.page, "spaces:context")).kind)
                .toBe("personal");
              await expect(
                bob.page.getByRole("button", { name: "Open Document Recovery", exact: true }),
              ).toBeVisible();
              await bob.page.screenshot({
                path: path.join(screenshots, "05-personal-unaffected.png"),
              });
            },
          );
        },
      );
    } finally {
      await aliceProxy.close();
      await bobProxy.close();
    }
  });
});
