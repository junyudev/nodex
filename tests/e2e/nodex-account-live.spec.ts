import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { materializeScenario } from "../../scripts/scenarios/seed/scenario-seed";
import {
  BOARD_DENSE_PRIMARY_PAGE_KEY,
  BOARD_DENSE_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/board-dense";
import { focusBoardDenseUi } from "../../scripts/scenarios/scenarios/board-dense-ui";
import {
  captureNodexBrowserHandoff,
  expectNodexAccount,
  openNodexAccount,
  readNativeAccount,
  readNodexAccount,
} from "./fixtures/nodex-account-ui";

interface AccountEvidenceClaim {
  readonly name: string;
  readonly phase: "setup" | "recording";
  readonly expected: unknown;
  readonly actual: unknown;
}

const requireSetting = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Live Clerk verification requires ${name}`);
  return value;
};

const holdReviewFrame = async (page: Page): Promise<void> => {
  await page.mouse.move(1240, 760);
  // Assertions own settling; keep each verified state readable in the native recording.
  await page.waitForTimeout(1_000);
};

// Interactive external-provider verification is never part of the unattended E2E gate.
test.skip(process.env.NODEX_LIVE_CLERK_E2E !== "1", "Requires explicit live Clerk opt-in");
test.use({ trace: "off" });

test("signs in with real Clerk and preserves local work after sign out", async ({}, testInfo) => {
  test.setTimeout(600_000);
  const issuer = requireSetting("NODEX_CLERK_ISSUER");
  const clientId = requireSetting("NODEX_CLERK_CLIENT_ID");
  const email = requireSetting("NODEX_LIVE_CLERK_EMAIL");
  expect(new URL(issuer).protocol).toBe("https:");
  const artifacts = process.env.NODEX_ACCOUNT_LIVE_ARTIFACT_DIR ?? testInfo.outputPath("live");
  await mkdir(artifacts, { recursive: true });
  const handoffPath = path.join(artifacts, "live-authorization.json");
  const claims: AccountEvidenceClaim[] = [];
  let phase: AccountEvidenceClaim["phase"] = "setup";
  const claim = (name: string, expected: unknown, actual: unknown): void => {
    claims.push({ name, phase, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  const harness = await ElectronScenarioHarness.create({
    label: "nodex-account-live",
    environment: {
      NODEX_CLERK_ISSUER: issuer,
      NODEX_CLERK_CLIENT_ID: clientId,
      NODEX_TEST_CLERK_LOOPBACK: "0",
    },
  });
  const credentialPath = path.join(harness.profile.nodexHome, "account/credentials.enc");
  const nativeAuthPath = path.join(harness.profile.codexHome, "auth.json");
  const nativeAuth = `${JSON.stringify({ OPENAI_API_KEY: "synthetic-native-account-marker" })}\n`;
  const claudeAuthPath = path.join(harness.profile.claudeConfigHome, ".credentials.json");
  const claudeAuth = `${JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-claude-marker" } })}\n`;
  let page: Page | undefined;
  let recording: Page | undefined;
  let status: "passed" | "failed" = "failed";
  let stage = "prepare";
  try {
    await rm(handoffPath, { force: true });
    await writeFile(nativeAuthPath, nativeAuth, { mode: 0o600 });
    await writeFile(claudeAuthPath, claudeAuth, { mode: 0o600 });
    page = await harness.launch();
    await page.setViewportSize({ width: 1280, height: 800 });
    const seed = new RendererIpcSeedAdapter(page);
    const manifest = await materializeScenario(
      BOARD_DENSE_SCENARIO_ID,
      seed,
      harness.profile.initialProjectsDirectory,
    );
    const pageId = manifest.pageIdsByKey[BOARD_DENSE_PRIMARY_PAGE_KEY]!;
    const localBefore = await seed.readPage(manifest.projectId, pageId);
    const nativeBefore = await readNativeAccount(page);
    expect(nativeBefore.account).toMatchObject({ type: "chatgpt", email: "queue@example.com" });
    let handoffs = await captureNodexBrowserHandoff(harness.application);
    await openNodexAccount(page);

    const signIn = async (attempt: "persistence" | "recording"): Promise<void> => {
      const current = harness.page;
      const before = (await handoffs()).length;
      await current.getByRole("button", { name: "Sign in", exact: true }).click();
      await expectNodexAccount(current, { status: "signing-in" });
      await expect.poll(async () => (await handoffs()).length).toBe(before + 1);
      const authorizationUrl = (await handoffs())[before]!;
      const parsed = new URL(authorizationUrl);
      expect(parsed.origin).toBe(new URL(issuer).origin);
      for (const secret of ["code", "access_token", "refresh_token", "id_token"])
        expect(parsed.searchParams.has(secret)).toBe(false);
      await writeFile(handoffPath, `${JSON.stringify({ attempt, authorizationUrl }, null, 2)}\n`, {
        mode: 0o600,
      });
      await expect
        .poll(async () => (await readNodexAccount(current)).status, {
          timeout: 240_000,
          intervals: [500, 1_000],
        })
        .toBe("signed-in");
      await rm(handoffPath, { force: true });
      await expectNodexAccount(current, {
        status: "signed-in",
        connection: "available",
        persistence: "secure",
        error: null,
      });
      await expect(current.getByText(email, { exact: true })).toBeVisible();
      const snapshot = await readNodexAccount(current);
      claim(
        `Clerk ${attempt} login returns the expected identity through Main`,
        { issuer, email, hasSubject: true, status: "signed-in", persistence: "secure" },
        {
          issuer: snapshot.account?.issuer,
          email: snapshot.account?.email,
          hasSubject: Boolean(snapshot.account?.subject),
          status: snapshot.status,
          persistence: snapshot.persistence,
        },
      );
    };

    stage = "first-clerk-login";
    await signIn("persistence");
    const firstIdentity = (await readNodexAccount(page)).account;
    claim("Encrypted credential file is nonempty", true, (await stat(credentialPath)).size > 0);
    if (process.platform !== "win32")
      claim("Credential file is private", 0o600, (await stat(credentialPath)).mode & 0o777);

    stage = "restart";
    page = await harness.restart();
    await page.setViewportSize({ width: 1280, height: 800 });
    handoffs = await captureNodexBrowserHandoff(harness.application);
    await openNodexAccount(page);
    await expectNodexAccount(page, {
      status: "signed-in",
      connection: "available",
      persistence: "secure",
      account: firstIdentity,
    });
    claim(
      "Restart restores the same Clerk account",
      firstIdentity,
      (await readNodexAccount(page)).account,
    );
    claim("Restart needs no browser authorization", [], await handoffs());
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expectNodexAccount(page, { status: "signed-out", account: null, persistence: null });
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();

    stage = "recorded-clerk-login";
    phase = "recording";
    await page.screencast.start({
      path: path.join(artifacts, "review.webm"),
      size: { width: 1280, height: 800 },
      annotate: { position: "bottom", fontSize: 14 },
    });
    recording = page;
    claim("Account starts signed out", "signed-out", (await readNodexAccount(page)).status);
    await holdReviewFrame(page);
    await signIn("recording");
    await page.screenshot({ path: path.join(artifacts, "identity.png") });
    await holdReviewFrame(page);

    stage = "recorded-sign-out";
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expectNodexAccount(page, { status: "signed-out", account: null, persistence: null });
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    const signedOut = await readNodexAccount(page);
    claim(
      "Sign out removes the Nodex identity",
      { status: "signed-out", account: null, persistence: null },
      { status: signedOut.status, account: signedOut.account, persistence: signedOut.persistence },
    );
    const credentialExists = await stat(credentialPath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    claim("Sign out removes the persisted Nodex credential", false, credentialExists);
    claim(
      "Native Codex identity survives Nodex sign out",
      nativeBefore.account,
      (await readNativeAccount(page)).account,
    );
    claim(
      "Native Codex credential remains byte-identical",
      true,
      (await readFile(nativeAuthPath, "utf8")) === nativeAuth,
    );
    claim(
      "Native Claude credential remains byte-identical",
      true,
      (await readFile(claudeAuthPath, "utf8")) === claudeAuth,
    );
    await page.screenshot({ path: path.join(artifacts, "signed-out.png") });
    await holdReviewFrame(page);

    stage = "recorded-local-work";
    await page.keyboard.press("Escape");
    await focusBoardDenseUi(page, manifest);
    const localAfter = await new RendererIpcSeedAdapter(page).readPage(manifest.projectId, pageId);
    claim(
      "Local Page survives Nodex sign out",
      {
        title: localBefore.title,
        descriptionPreview: localBefore.descriptionPreview,
        documentReadiness: "ready",
      },
      {
        title: localAfter.title,
        descriptionPreview: localAfter.descriptionPreview,
        documentReadiness: localAfter.documentReadiness,
      },
    );
    const editor = page.locator('.nfm-editor .ProseMirror[contenteditable="true"]:visible');
    await expect(editor).toBeVisible();
    claim("Local Page remains editable while signed out", true, await editor.isEditable());
    const localEdit = "Local editing continues after Nodex sign out.";
    await editor.click();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.insertText(localEdit);
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          (await new RendererIpcSeedAdapter(page!).readPage(manifest.projectId, pageId))
            .descriptionPreview,
      )
      .toContain(localEdit);
    claim(
      "Local editing commits through Core while signed out",
      true,
      (
        await new RendererIpcSeedAdapter(page).readPage(manifest.projectId, pageId)
      ).descriptionPreview.includes(localEdit),
    );
    claim(
      "Opening the local Page does not sign in",
      "signed-out",
      (await readNodexAccount(page)).status,
    );
    await page.screenshot({ path: path.join(artifacts, "final.png") });
    await holdReviewFrame(page);
    status = "passed";
    stage = "complete";
  } finally {
    try {
      await rm(handoffPath, { force: true });
      await recording?.screencast.stop();
      await writeFile(
        path.join(artifacts, "result.json"),
        `${JSON.stringify({ status, fixture: "board/dense@3, disposable Electron Profile, real Clerk OAuth, synthetic native Codex peer", issuer, email, stage, claims }, null, 2)}\n`,
      );
      await writeFile(
        path.join(artifacts, "README.md"),
        `# Nodex account verification\n\nStatus: **${status}**. Last stage: ${stage}.\n\nThe test uses a fresh disposable Profile and the authoritative board/dense seed. Real Clerk discovery, PKCE authorization, loopback callback, token exchange, userinfo, secure credential persistence and sign out run through Main. The OS browser handoff is transferred to a separately controlled browser; no token or callback code is written to artifacts.\n\nBefore recording, a first login is restored through an actual Electron restart without another browser authorization. One uninterrupted native recording then shows a second real login, the identity, sign out and the existing editable local Page. Exact expected and actual checks, separated by setup and recording phases, are in result.json.\n\nThe preserved native Codex identity and Codex/Claude credential files are synthetic harness fixtures. This does not verify real Codex/Claude login, a paid Nodex subscription, Stripe checkout, or cloud inference.\n\nFiles: review.webm, identity.png, signed-out.png, final.png, result.json. The temporary authorization handoff is removed on completion.\n\nRun with NODEX_LIVE_CLERK_E2E=1, NODEX_CLERK_ISSUER, NODEX_CLERK_CLIENT_ID, NODEX_LIVE_CLERK_EMAIL and NODEX_ACCOUNT_LIVE_ARTIFACT_DIR, then vp run test:e2e tests/e2e/nodex-account-live.spec.ts. Complete both pending browser authorizations while the test waits.\n`,
      );
    } finally {
      await harness.close();
    }
  }
});
