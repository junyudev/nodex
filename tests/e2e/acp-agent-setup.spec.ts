import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { chooseComposerModel } from "./support/composer-model-picker";
import { waitForDraftScene } from "./support/new-chat-draft";
import { openWorkbenchSettings } from "./support/workbench-settings";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { createScriptedAcpRegistryFixture } from "../../scripts/scenarios/runtime/scripted-acp-registry-fixture";
import {
  AGENT_CLI_PROJECT_NAME,
  AGENT_CLI_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/agent-cli-workflow";
import type { AcpOperations } from "../../src/shared/acp-api";
import type { AcpAgentSettings } from "../../src/shared/acp-agent-settings";
import type { AgentRuntimeConversation } from "../../src/shared/agent-runtime-api";
import { agentRuntimeProviderId } from "../../src/shared/agent-runtime-provider";
import type { ProjectSession } from "../../src/shared/types";

const instanceName = "Registry Setup Agent";
const userMessage = "ACP_REGISTRY_SETUP_USER_MESSAGE";

/** The installed peer's record of each protocol request it received, in order. */
interface PeerObservation {
  readonly method: string;
  readonly sessionId?: string;
  readonly configId?: string;
  readonly value?: string;
  readonly promptText?: readonly string[];
}

interface RegistryRequest {
  readonly url: string;
  readonly method: string;
}

const readOptional = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
};

const readObservations = (observationPath: string): readonly PeerObservation[] =>
  JSON.parse(readOptional(observationPath) ?? "[]") as PeerObservation[];

const readRegistryRequests = (requestsPath: string): readonly RegistryRequest[] =>
  (readOptional(requestsPath) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RegistryRequest);

const invoke = async <Result>(page: Page, channel: string, ...args: unknown[]): Promise<Result> =>
  (await page.evaluate(
    async ({ targetChannel, targetArgs }) => {
      if (!window.api) throw new Error("Nodex preload API is unavailable");
      const api = window.api as unknown as {
        invoke(target: string, ...input: unknown[]): Promise<unknown>;
      };
      const result = await api.invoke(targetChannel, ...targetArgs);
      if (!targetChannel.startsWith("acp:")) return result;
      const envelope = result as { ok: boolean; value?: unknown; error?: { message: string } };
      if (!envelope.ok) throw new Error(envelope.error?.message ?? "ACP request failed");
      return envelope.value;
    },
    { targetChannel: channel, targetArgs: args },
  )) as Result;

/** The value shown beside a term in the installation preview. */
const previewValue = (dialog: Locator, term: string): Locator =>
  dialog
    .locator("dt")
    .filter({ hasText: new RegExp(`^${term}$`, "u") })
    .locator("xpath=following-sibling::dd[1]");

const isInside = (child: string, parent: string): boolean => {
  const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

test("installs an ACP Agent from the Registry and chats with the installed Agent", async ({}, testInfo) => {
  test.setTimeout(180_000);
  // Only the external Registry index and download are fixtures; installation, connection,
  // model selection and the chat run through the production UI, Main and Agent Runtime.
  const fixture = await createScriptedAcpRegistryFixture(testInfo.outputPath("registry-fixture"));
  const attachText = async (name: string, filePath: string) => {
    const body = readOptional(filePath);
    if (body !== null) await testInfo.attach(name, { body, contentType: "text/plain" });
  };

  await withElectronScenario(
    {
      label: "acp-agent-setup",
      scenarioId: AGENT_CLI_SCENARIO_ID,
      environment: fixture.environment,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("runtime", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        if (page)
          await testInfo.attach("page", {
            body: await page.screenshot(),
            contentType: "image/png",
          });
        await attachText("peer-observations", fixture.observationPath);
        await attachText("registry-requests", fixture.requestsPath);
      },
    },
    async ({ page, profile, manifest }) => {
      if (!manifest) throw new Error("ACP setup requires the Agent CLI Project");
      // A fresh Profile has no ACP Agent until the user installs one.
      expect((await invoke<AcpAgentSettings>(page, "settings:acp-agents:get")).instances).toEqual(
        [],
      );

      await openWorkbenchSettings(page);
      await page.getByRole("link", { name: "Agents", exact: true }).click();
      const otherAgents = page.getByRole("region", { name: "Other agents", exact: true });
      await otherAgents
        .getByRole("button", { name: "Other agents", exact: true, expanded: false })
        .click();
      await expect(otherAgents.getByText("Add an agent", { exact: true })).toBeVisible();
      await otherAgents.getByRole("button", { name: "Add agent", exact: true }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toHaveAccessibleName("Add Agent");
      await expect(dialog.getByRole("tab", { name: "ACP Registry", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      const search = dialog.getByRole("textbox", { name: "Search the ACP Registry", exact: true });
      const results = dialog.getByRole("list", { name: "Registry Agents", exact: true });
      // The Registry answers the query: an unrelated term finds nothing.
      await search.fill("unlisted-agent");
      await expect(results).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
      await expect(results.getByText("No Agents match “unlisted-agent”.")).toBeVisible();
      await search.fill("scripted registry");
      await expect(results).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
      const result = results.getByRole("listitem");
      await expect(result).toHaveCount(1);
      await expect(result).toContainText(fixture.agentName);
      await expect(result).toContainText(`v${fixture.version}`);
      await expect(result).toContainText("Binary");
      await result.getByRole("button").click();

      await expect(dialog).toHaveAccessibleName(fixture.agentName);
      const name = dialog.getByRole("textbox", { name: "Name", exact: true });
      await expect(name).toHaveValue(fixture.agentName);
      await name.fill(instanceName);
      // A separate account folder keeps the installed Agent away from the host user's sign-ins.
      const accountHome = path.join(profile.runRoot, "registry-agent-account");
      fs.mkdirSync(accountHome);
      await dialog.getByRole("button", { name: "Account storage", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Separate folder/u }).click();
      await dialog
        .getByRole("textbox", { name: "Separate account folder", exact: true })
        .fill(accountHome);

      // The preview names exactly what will be downloaded, verified and installed.
      const download = previewValue(dialog, "Download");
      await expect(download).toHaveText(/^https:\/\//u, { timeout: 30_000 });
      await expect(previewValue(dialog, "Integrity")).toHaveText(
        `SHA-256 ${fixture.archiveSha256.slice(0, 16)}…`,
      );
      const downloadUrl = (await download.textContent())!;
      const installDirectory = (await previewValue(dialog, "Installs to").textContent())!;
      expect(path.isAbsolute(installDirectory)).toBe(true);
      expect(fs.existsSync(installDirectory)).toBe(false);
      expect(
        readRegistryRequests(fixture.requestsPath).filter(({ url }) => url === downloadUrl),
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("acp-registry-preview.png") });

      const install = dialog.getByRole("button", { name: "Install and connect", exact: true });
      await expect(install).toBeEnabled();
      await install.click();
      await expect(dialog).toBeHidden();
      await expect(otherAgents.getByText(/^Ready · [1-9]\d* models?$/u)).toBeVisible({
        timeout: 90_000,
      });
      await expect(
        otherAgents.getByText(`${fixture.agentId} · v${fixture.version} · Binary`, {
          exact: true,
        }),
      ).toBeVisible();

      // The saved Agent is pinned to the managed installation, not a local command.
      const savedInstance = async () => {
        const { instances } = await invoke<AcpAgentSettings>(page, "settings:acp-agents:get");
        expect(instances).toHaveLength(1);
        return instances[0]!;
      };
      await expect
        .poll(async () => {
          const { source } = await savedInstance();
          return source.kind === "registry" ? (source.installationId ?? null) : null;
        })
        .toMatch(/^[a-f0-9]{64}$/u);
      const instance = await savedInstance();
      expect(instance).toMatchObject({
        agentDefinitionId: fixture.agentId,
        displayName: instanceName,
        enabled: true,
        source: { kind: "registry", agentId: fixture.agentId, distribution: "auto" },
        credentials: { kind: "isolated-home" },
      });
      const { source, credentials } = instance;
      if (source.kind !== "registry" || credentials.kind !== "isolated-home")
        throw new Error("The Agent was not saved as a Registry install with its own account");
      expect(source.executableOverride).toBeUndefined();
      expect(fs.realpathSync(credentials.home)).toBe(fs.realpathSync(accountHome));
      expect(
        await invoke<AcpOperations["acp.inspect"]["output"]>(page, "acp:inspect", {
          instanceId: instance.id,
        }),
      ).toMatchObject({
        status: "ready",
        agentId: fixture.agentId,
        version: fixture.version,
        distribution: "binary",
      });

      // The offered bytes were downloaded once and installed privately in this Profile.
      const runtimeHome = path.join(profile.nodexHome, "agent-runtime");
      const executable = path.join(installDirectory, "scripted-agent");
      expect(isInside(executable, runtimeHome)).toBe(true);
      expect(fs.statSync(executable).mode & 0o111).not.toBe(0);
      expect(createHash("sha256").update(fs.readFileSync(executable)).digest("hex")).toBe(
        fixture.archiveSha256,
      );
      const registryRequests = readRegistryRequests(fixture.requestsPath);
      expect(registryRequests.filter(({ url }) => url === downloadUrl)).toEqual([
        { url: downloadUrl, method: "GET" },
      ]);
      expect(registryRequests.some(({ url }) => url !== downloadUrl)).toBe(true);
      const receipts = fs
        .readdirSync(runtimeHome, { recursive: true, encoding: "utf8" })
        .filter((entry) => path.basename(entry) === `${source.installationId}.json`);
      expect(receipts).toHaveLength(1);
      expect(
        JSON.parse(fs.readFileSync(path.join(runtimeHome, receipts[0]!), "utf8")),
      ).toMatchObject({
        agent: { id: fixture.agentId, version: fixture.version },
        distribution: "binary",
      });

      await page.getByRole("button", { name: "Back to app" }).click();
      await page
        .getByRole("button", { name: `Start new chat in ${AGENT_CLI_PROJECT_NAME}`, exact: true })
        .click();
      const draftSessionId = async () => {
        const tasks = await invoke<{
          readonly items: readonly {
            readonly id: string;
            readonly thread?: unknown;
            readonly executionRef?: unknown;
          }[];
        }>(page, "workspace:tasks:list", manifest.projectId, { first: 50 });
        // A draft has neither a native Thread nor an Agent execution binding.
        const drafts = tasks.items.filter(
          (task) => task.thread == null && task.executionRef == null,
        );
        return drafts.length === 1 ? drafts[0]!.id : null;
      };
      await expect.poll(draftSessionId, { timeout: 30_000 }).not.toBeNull();
      const sessionId = (await draftSessionId())!;
      const scene = await waitForDraftScene(page, sessionId);
      const composer = scene.locator(
        '[data-codex-composer="true"][contenteditable="true"]:visible',
      );
      await expect(async () => {
        await composer.fill(userMessage);
        await expect(composer).toHaveText(userMessage, { timeout: 1_000 });
      }).toPass({ timeout: 10_000 });
      // The installed Agent's discovered model, disambiguated by the name the user gave it.
      await chooseComposerModel(page, `${instanceName} ${fixture.modelId}`);
      await expect(composer).toHaveText(userMessage);
      expect(
        readObservations(fixture.observationPath).filter(
          ({ method }) => method === "session/prompt",
        ),
      ).toEqual([]);
      await expect(scene.getByText(fixture.reply, { exact: true })).toHaveCount(0);
      await scene.getByRole("button", { name: "Send prompt", exact: true }).click();

      await expect(scene.getByText(fixture.reply, { exact: true })).toBeVisible({
        timeout: 90_000,
      });
      await expect(scene.getByText(userMessage, { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("acp-registry-reply.png") });

      // The reply came from the newly saved instance's own protocol session and model.
      await expect
        .poll(
          async () =>
            (await invoke<ProjectSession>(page, "project-sessions:get", sessionId)).executionRef,
        )
        .toBeTruthy();
      const { executionRef } = await invoke<ProjectSession>(
        page,
        "project-sessions:get",
        sessionId,
      );
      const control = await invoke<AgentRuntimeConversation>(
        page,
        "agent-runtime:session:control",
        { sessionId, threadId: executionRef!.threadId },
      );
      const { thread, providerThreads } = control.snapshot.projection;
      const providerId = agentRuntimeProviderId({
        kind: "acp",
        agentDefinitionId: instance.agentDefinitionId,
        instanceConfigId: instance.id,
      });
      expect(thread.providerInstanceId).toBe(providerId);
      expect(thread.modelSelection).toMatchObject({
        instanceId: providerId,
        model: fixture.modelId,
      });
      expect(
        providerThreads.find(({ id }) => id === thread.activeProviderThreadId)?.nativeThreadRef
          ?.nativeId,
      ).toBe(fixture.sessionId);

      // On the wire, the installed peer received the model choice before the user's prompt.
      const observations = readObservations(fixture.observationPath);
      expect(observations.some(({ method }) => method === "session/new")).toBe(true);
      const modelChoice = observations.findIndex(
        ({ method, configId, value }) =>
          method === "session/set_config_option" &&
          configId === "model" &&
          value === fixture.modelId,
      );
      const prompts = observations.filter(({ method }) => method === "session/prompt");
      expect(modelChoice).toBeGreaterThanOrEqual(0);
      expect(modelChoice).toBeLessThan(observations.indexOf(prompts[0]!));
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.sessionId).toBe(fixture.sessionId);
      expect(prompts[0]!.promptText?.some((block) => block.includes(userMessage))).toBe(true);
    },
  );
});
