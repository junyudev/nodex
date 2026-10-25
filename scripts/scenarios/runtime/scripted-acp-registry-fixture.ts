import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScriptedAcpScenario } from "./scripted-acp-agent";

const registryUrl = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const archiveUrl = "https://nodex-acp-fixture.invalid/scripted-agent.bin";
// Playwright loads scenario helpers as CommonJS from the repository root.
const peerPath = path.resolve("scripts/scenarios/runtime/scripted-acp-agent.ts");
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export interface ScriptedAcpRegistryFixture {
  readonly agentId: string;
  readonly agentName: string;
  readonly version: string;
  readonly modelId: string;
  readonly reply: string;
  readonly sessionId: string;
  readonly observationPath: string;
  readonly requestsPath: string;
  readonly archivePath: string;
  readonly archiveSha256: string;
  /** Pass to ElectronScenarioHarness.create; its existing test-only Node seam loads the fixture. */
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * Fixtures only the external Registry index and download. The real Runtime still searches,
 * verifies, installs, pins and executes the downloaded entrypoint, which runs the authoritative
 * scripted ACP peer. No Agent Instance or installed receipt is seeded.
 *
 * Own a fresh directory for each test/retry. This executable fixture supports POSIX hosts;
 * it makes no claim about Windows installation or packaged-app verification.
 */
export async function createScriptedAcpRegistryFixture(
  directory: string,
): Promise<ScriptedAcpRegistryFixture> {
  if (!path.isAbsolute(directory))
    throw new Error("ACP Registry fixture requires an absolute path");
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("ACP Registry fixture requires a POSIX host");
  if (process.arch !== "arm64" && process.arch !== "x64")
    throw new Error("ACP Registry fixture requires arm64 or x64");
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
  const agentId = "nodex-scripted-registry-agent";
  const agentName = "Scripted Registry Agent";
  const version = "1.0.0";
  const modelId = "scripted-registry-model";
  const reply = "ACP_REGISTRY_INSTALLED_PEER_REPLY";
  const sessionId = "scripted-registry-session";
  const observationPath = path.join(directory, "peer-observations.json");
  const requestsPath = path.join(directory, "registry-requests.jsonl");
  const archivePath = path.join(directory, "scripted-agent.bin");
  const scenario: ScriptedAcpScenario = {
    sessionId,
    sessionLifecycle: { load: true },
    sessionConfig: {
      id: "model",
      category: "model",
      currentValue: "default",
      values: ["default", modelId],
    },
    beforePrompt: [`${reply}\n\n`],
    recordPromptText: true,
  };
  const archive = [
    "#!/bin/sh",
    `export NODEX_SCRIPTED_ACP_SCENARIO=${shellQuote(JSON.stringify(scenario))}`,
    `export NODEX_SCRIPTED_ACP_OBSERVATION=${shellQuote(observationPath)}`,
    `exec ${shellQuote(process.execPath)} ${shellQuote(peerPath)}`,
    "",
  ].join("\n");
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  const target = `${process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
  const registry = {
    version: "1.0.0",
    agents: [
      {
        id: agentId,
        name: agentName,
        description: "Deterministic ACP process fixture",
        version,
        distribution: {
          binary: {
            [target]: { archive: archiveUrl, cmd: "scripted-agent", sha256: archiveSha256 },
          },
        },
      },
    ],
  };
  const preloadPath = path.join(directory, "registry-fetch.cjs");
  const nodePath = path.join(directory, "runtime-node");
  const preload = `const { appendFileSync, readFileSync } = require("node:fs");
const originalFetch = globalThis.fetch;
const registryUrl = ${JSON.stringify(registryUrl)};
const archiveUrl = ${JSON.stringify(archiveUrl)};
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== registryUrl && url !== archiveUrl) return originalFetch(input, init);
  const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
  if (method !== "GET") throw new Error("Unexpected ACP fixture request method");
  appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify({ url, method }) + "\\n");
  return new Response(url === registryUrl ? ${JSON.stringify(JSON.stringify(registry))} : readFileSync(${JSON.stringify(archivePath)}), {
    headers: { "content-type": url === registryUrl ? "application/json" : "application/octet-stream" },
  });
};
`;
  await Promise.all([
    writeFile(archivePath, archive, { mode: 0o700 }),
    writeFile(preloadPath, preload),
    writeFile(
      nodePath,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} --require ${shellQuote(preloadPath)} "$@"\n`,
      { mode: 0o700 },
    ),
  ]);
  return {
    agentId,
    agentName,
    version,
    modelId,
    reply,
    sessionId,
    observationPath,
    requestsPath,
    archivePath,
    archiveSha256,
    environment: { NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: nodePath },
  };
}
