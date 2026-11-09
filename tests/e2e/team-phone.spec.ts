import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import electron from "electron";
import { expect, test } from "@playwright/test";
import { encodeDeviceLink } from "@nodex/mobile-protocol";
import type { components } from "@nodex/core-protocol";
import { CoreClient } from "../../src/main/core-client/core-client";
import { enrollRemoteCore } from "../../src/main/core-client/remote-http";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { invokeIpc } from "./support/editor-scenario";
import { MobilePhone, type PhoneChannel } from "./support/mobile-phone";

const exec = promisify(execFile);

test("Bob's phone retains only Bob's Turns while the team host runs with Alice's desktop closed", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const root = await realpath(await mkdtemp("/tmp/ndx-phone-"));
  const home = path.join(root, "space");
  const clone = path.join(root, "clone");
  const cli = path.resolve("target/debug/nodex");
  const environment = {
    ...process.env,
    NODEX_HOME: home,
    NODEX_AGENT_ENDPOINT: undefined,
    NODEX_AGENT_CREDENTIAL: undefined,
    NODEX_AGENT_ATTRIBUTION: undefined,
    NODE_ENV: "test",
    NODEX_CORE_BINARY: path.resolve("target/debug/nodex-core"),
    NODEX_TEST_HOST_ELECTRON: electron as unknown as string,
    NODEX_TEST_HOST_ENTRY: path.resolve("out/main/serve.js"),
    NODEX_LOG_FILE: "1",
    NODEX_LOG_DIR: path.join(home, "logs"),
    CODEX_HOME: path.join(root, "codex"),
  };
  const command = async <T>(...args: string[]): Promise<T> => {
    const { stdout } = await exec(cli, ["--json", ...args], { env: environment, timeout: 90_000 });
    const result = JSON.parse(stdout) as { ok: boolean; result: T };
    expect(result.ok).toBe(true);
    return result.result;
  };
  const serve = <T>(...args: string[]) => command<T>("serve", ...args, "--home", home);
  let pid: number | undefined;
  let phone: PhoneChannel | undefined;
  let laptop: ElectronScenarioHarness | undefined;
  try {
    await mkdir(clone, { recursive: true });
    await mkdir(environment.CODEX_HOME);
    await writeFile(path.join(clone, "README.md"), "# Phone host\n");
    await exec("git", ["init", "-b", "main"], { cwd: clone });
    await exec("git", ["remote", "add", "origin", "https://git.example/team/phone.git"], {
      cwd: clone,
    });
    await exec("git", ["add", "README.md"], { cwd: clone });
    await exec(
      "git",
      [
        "-c",
        "user.name=Phone fixture",
        "-c",
        "user.email=phone@example.test",
        "commit",
        "-m",
        "Initial fixture",
      ],
      { cwd: clone },
    );
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const space = await serve<{ spaceId: string; projectId: string }>(
      "init",
      "--address",
      `127.0.0.1:${address.port}`,
      "--name",
      "Phone Crew",
      "--project-name",
      "Phone Project",
      "--repository",
      "https://git.example/team/phone",
      "--clone",
      clone,
    );
    pid = (await serve<{ pid: number }>("start")).pid;
    const host = await CoreClient.connect({
      nodexHome: home,
      clientKind: "electron_host",
      buildId: "team-phone-e2e",
    });
    const invite = await serve<components["schemas"]["InviteResponse"]>(
      "invite",
      "--role",
      "owner",
    );
    laptop = await ElectronScenarioHarness.create({
      label: "team-phone-laptop",
      prepareAgentRuntime: false,
    });
    const page = await laptop.launch();
    const joined = await invokeIpc(page, "spaces:join", {
      inviteUrl: invite.url,
      deviceLabel: "Alice laptop",
      fingerprint: invite.fingerprint,
      code: invite.code,
      displayName: "Alice",
    });
    const enroll = async (name: string, memberId?: string) => {
      const invite = await host.spaceInvite({
        role: memberId ? "owner" : "member",
        ...(memberId ? { member_id: memberId } : {}),
      });
      const device = await enrollRemoteCore(invite, {
        code: invite.code,
        device_label: `${name}'s desktop`,
        display_name: name,
      });
      const client = await CoreClient.connectRemote({
        ...invite,
        spaceId: device.space_id,
        deviceCredential: device.device_credential,
        buildId: "team-phone-e2e",
      });
      return { device, client };
    };
    if (!joined.memberId) throw new Error("Missing Alice Member");
    const alice = await enroll("Alice", joined.memberId);
    const bob = await enroll("Bob");
    const offer = await bob.client.spaceLinkDevice();
    const identity = MobilePhone.fromCopiedLink(encodeDeviceLink(offer));
    phone = await identity.connect(true);
    expect((await phone.hello).memberId).toBe(bob.device.member_id);
    expect((await phone.hello).spaceKind).toBe("team");
    // The execution owner records bounded provider observations through its real semantic boundary.
    // No storage fixture or phone-projection mock can decide the recipient.
    const turn = async (member: typeof bob, title: string) => {
      const pageId = createUuidV7();
      const sessionId = createUuidV7();
      await host.workspaceApply({
        operationId: createBoundedOperationId("team.phone"),
        intent: {
          kind: "create_page_for",
          for: { kind: "project", project_id: space.projectId },
          page_id: pageId,
          document_id: createUuidV7(),
          title,
        },
      });
      await member.client.workspaceApply({
        operationId: createBoundedOperationId("team.phone"),
        intent: {
          kind: "start_page_work",
          page_id: pageId,
          selection: { instanceId: "codex", model: "model", effort: null },
          session_id: sessionId,
          launch_id: createUuidV7(),
          message_id: createUuidV7(),
          brief: "Phone work",
          again: false,
          expected_readiness_epoch: null,
          expected_turn_episode: null,
        },
      });
      await host.workspaceApply({
        operationId: createBoundedOperationId("team.phone"),
        intent: {
          kind: "create_agent_runtime_session",
          session_id: sessionId,
          project_id: space.projectId,
          title,
          initial_page_ids: [pageId],
          runtime_id: `runtime:${sessionId}`,
          runtime_thread_id: `thread:${sessionId}`,
          launch_request_id: `launch:${sessionId}`,
        },
      });
      // The host's Runtime observes the Session it just launched, so record against the
      // revision it holds now, and again if it moves between that read and this write.
      for (let attempt = 0; ; attempt += 1) {
        const observer = await host.workspaceRead({
          kind: "session_execution_observer",
          session_id: sessionId,
        });
        if (observer.value.kind !== "session_execution_observer")
          throw new Error("Missing execution observer");
        try {
          await host.workspaceApply({
            operationId: createBoundedOperationId("team.phone"),
            intent: {
              kind: "record_session_execution",
              session_id: sessionId,
              expected_revision: observer.value.observer?.revision ?? 0,
              observation: {
                state: "waiting",
                runId: createUuidV7(),
                runStartedAt: 0,
                pendingRequestIds: ["question"],
                pendingRequests: [
                  {
                    id: "question",
                    kind: "question",
                    question: `${title}?`,
                    options: ["Yes", "No"],
                  },
                ],
                queue: null,
                terminalStatus: null,
                personStopped: false,
                stalled: false,
                progressFingerprint: "question",
                progressSince: 0,
              },
              events: [],
              resolved_request_ids: [],
            },
          });
          break;
        } catch (error) {
          if (attempt >= 4 || !String(error).includes("revision changed")) throw error;
        }
      }
      return pageId;
    };
    const alicePage = await turn(alice, "Alice only");
    const bobPage = await turn(bob, "Bob only");
    const inbox = () => phone!.request("inbox.window", { scope: { kind: "all" }, filter: "inbox" });
    await expect
      .poll(async () =>
        (await inbox()).items.filter((item) => item.rowKind === "turn").map((item) => item.pageId),
      )
      .toContain(bobPage);
    expect(
      (await inbox()).items.some((item) => item.rowKind === "turn" && item.pageId === alicePage),
    ).toBe(false);
    await laptop.close();
    laptop = undefined;
    await phone.close();
    phone = await identity.connect();
    expect(
      (await inbox()).items.some((item) => item.rowKind === "turn" && item.pageId === bobPage),
    ).toBe(true);
    const operationId = createUuidV7();
    expect(
      await phone.request("inbox.capture", {
        operationId,
        pageId: createUuidV7(),
        documentId: createUuidV7(),
        issuedAt: Date.now(),
        scope: { kind: "library" },
        text: "Bob with the laptop closed",
        fileRefs: [],
      }),
    ).toHaveProperty("pageId");
    await host.spaceRevokeDevice({ device_id: (await phone.hello).deviceId });
    expect(await phone.waitForClose()).toBe(4401);
    await expect(identity.connect()).rejects.toThrow("Device renewal refused (401)");
  } finally {
    await phone?.close();
    await laptop?.close();
    if (pid) {
      process.kill(pid, "SIGTERM");
      await expect
        .poll(async () => (await serve<{ state: string }>("status")).state, { timeout: 30_000 })
        .toBe("stopped");
    }
    const log = await readFile(path.join(home, "logs/host.log"), "utf8").catch(() => "");
    await testInfo.attach("team-phone-host.log", {
      body: Buffer.from(log),
      contentType: "text/plain",
    });
    await rm(root, { recursive: true, force: true });
  }
});
