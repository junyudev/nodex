import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk/unstable";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { createScriptedAcpRegistryFixture } from "./scripted-acp-registry-fixture";

const execute = promisify(execFile);

const temporary = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nodex-acp-registry-fixture-"));
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
};

test("fixtures Registry fetches without replacing unrelated fetch or reusing a fixture directory", async () => {
  const home = await temporary();
  try {
    const directory = path.join(home.root, "fixture with 'quoted' path");
    const fixture = await createScriptedAcpRegistryFixture(directory);
    const { stdout } = await execute(
      fixture.environment.NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE!,
      [
        "-e",
        `void (async () => {
        const registry = await (await fetch(new URL("https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"))).json();
        const agent = registry.agents[0];
        const target = Object.values(agent.distribution.binary)[0];
        const bytes = await (await fetch(new Request(target.archive))).arrayBuffer();
        const digest = require("node:crypto").createHash("sha256").update(Buffer.from(bytes)).digest("hex");
        const passthrough = await (await fetch("data:text/plain,original-fetch")).text();
        console.log(JSON.stringify({ agentId: agent.id, advertised: target.sha256, digest, passthrough }));
      })().catch((error) => { console.error(error); process.exitCode = 1; });`,
      ],
    );
    expect(JSON.parse(stdout)).toEqual({
      agentId: fixture.agentId,
      advertised: fixture.archiveSha256,
      digest: fixture.archiveSha256,
      passthrough: "original-fetch",
    });
    expect(
      createHash("sha256")
        .update(await readFile(fixture.archivePath))
        .digest("hex"),
    ).toBe(fixture.archiveSha256);
    expect(
      (await readFile(fixture.requestsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        url: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
        method: "GET",
      },
      { url: "https://nodex-acp-fixture.invalid/scripted-agent.bin", method: "GET" },
    ]);
    await expect(createScriptedAcpRegistryFixture(directory)).rejects.toMatchObject({
      code: "EEXIST",
    });
  } finally {
    await home.dispose();
  }
});

test("downloaded executable runs the authoritative ACP model and prompt protocol", async () => {
  const home = await temporary();
  try {
    const fixture = await createScriptedAcpRegistryFixture(path.join(home.root, "fixture"));
    const downloaded = path.join(home.root, "downloaded-agent");
    await execute(fixture.environment.NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE!, [
      "-e",
      `void fetch("https://nodex-acp-fixture.invalid/scripted-agent.bin").then(async response => {
        require("node:fs").writeFileSync(${JSON.stringify(downloaded)}, Buffer.from(await response.arrayBuffer()), {mode: 0o700});
      }).catch(error => { console.error(error); process.exitCode = 1; });`,
    ]);
    const child = spawn(downloaded, [], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    const text: string[] = [];
    const application = client().onNotification(methods.client.session.update, ({ params }) => {
      if (
        params.update.sessionUpdate === "agent_message_chunk" &&
        params.update.content.type === "text"
      )
        text.push(params.update.content.text);
    });
    try {
      await application.connectWith(
        ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ),
        async (agent) => {
          const options = { cancellationSignal: AbortSignal.timeout(5000) };
          await agent.request(
            methods.agent.initialize,
            { protocolVersion: 1, clientCapabilities: {} },
            options,
          );
          const session = await agent.request(
            methods.agent.session.new,
            { cwd: home.root, mcpServers: [] },
            options,
          );
          expect(session.sessionId).toBe(fixture.sessionId);
          expect(session.configOptions).toMatchObject([
            { id: "model", options: [{ value: "default" }, { value: fixture.modelId }] },
          ]);
          await agent.request(
            methods.agent.session.setConfigOption,
            {
              sessionId: session.sessionId,
              configId: "model",
              value: fixture.modelId,
            },
            options,
          );
          expect(
            await agent.request(
              methods.agent.session.prompt,
              {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "Reply from this installed Agent." }],
              },
              options,
            ),
          ).toMatchObject({ stopReason: "end_turn" });
        },
      );
      expect(text).toContain(`${fixture.reply}\n\n`);
      const observed = JSON.parse(await readFile(fixture.observationPath, "utf8"));
      expect(observed).toContainEqual({
        method: "session/set_config_option",
        configId: "model",
        value: fixture.modelId,
      });
      expect(observed).toContainEqual({
        method: "session/prompt",
        sessionId: fixture.sessionId,
        promptText: ["Reply from this installed Agent."],
      });
    } finally {
      clearTimeout(deadline);
      child.kill("SIGKILL");
      await exited;
    }
  } finally {
    await home.dispose();
  }
});
