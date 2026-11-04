import path from "node:path";
import { expect, it } from "vite-plus/test";
import {
  agentRuntimeEntrypoint,
  agentRuntimeNodeExecutable,
  scenarioAgentRuntimeProjectRoot,
} from "./AgentRuntimeEntrypoint";

const verifiedNode = (executable: string) => ({
  status: "available" as const,
  source: "standalone" as const,
  version: "24.22.1",
  executable,
});
const unavailableNode = { status: "unavailable" as const, message: "Not staged" };

it("keeps packaged execution outside ASAR and ignores every test executable override", () => {
  expect(
    agentRuntimeEntrypoint({
      isPackaged: true,
      resourcesPath: "/Nodex App/Contents/Resources",
      projectRootPath: "/repo",
    }),
  ).toBe(path.join("/Nodex App/Contents/Resources", "agent-runtime/entry.mjs"));
  expect(
    agentRuntimeNodeExecutable({
      isPackaged: true,
      nodeRuntime: verifiedNode("/verified/node"),
      environment: {
        NODE_ENV: "test",
        NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
        NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: "/scenario/node",
      },
    }),
  ).toBe("/verified/node");
});

it("admits a scripted development home and keeps packaged and ordinary execution verified", () => {
  const environment = {
    NODE_ENV: "development",
    NODEX_DEV_AGENT_RUNTIME_PROJECT_ROOT: "/scenario/scripted-agent-runtime",
    NODEX_DEV_AGENT_RUNTIME_NODE_EXECUTABLE: process.execPath,
  };
  expect(scenarioAgentRuntimeProjectRoot({ isPackaged: false, environment })).toBe(
    "/scenario/scripted-agent-runtime",
  );
  expect(
    agentRuntimeNodeExecutable({ isPackaged: false, nodeRuntime: unavailableNode, environment }),
  ).toBe(process.execPath);
  expect(scenarioAgentRuntimeProjectRoot({ isPackaged: true, environment })).toBeUndefined();
  expect(
    agentRuntimeNodeExecutable({
      isPackaged: true,
      nodeRuntime: verifiedNode("/verified/node"),
      environment,
    }),
  ).toBe("/verified/node");
  expect(
    scenarioAgentRuntimeProjectRoot({
      isPackaged: false,
      environment: { NODE_ENV: "development" },
    }),
  ).toBeUndefined();
  expect(() =>
    agentRuntimeNodeExecutable({
      isPackaged: false,
      nodeRuntime: unavailableNode,
      environment: { ...environment, NODEX_DEV_AGENT_RUNTIME_PROJECT_ROOT: "" },
    }),
  ).toThrow("verified Node");
});

it("admits an explicit absolute Node only inside an identified disposable test runtime", () => {
  const environment = {
    NODE_ENV: "test",
    NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
    NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: process.execPath,
  };
  expect(
    agentRuntimeNodeExecutable({ isPackaged: false, nodeRuntime: unavailableNode, environment }),
  ).toBe(process.execPath);
  for (const changed of [
    { ...environment, NODE_ENV: "development" },
    { ...environment, NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: "" },
  ])
    expect(() =>
      agentRuntimeNodeExecutable({
        isPackaged: false,
        nodeRuntime: unavailableNode,
        environment: changed,
      }),
    ).toThrow("verified Node");
  expect(() =>
    agentRuntimeNodeExecutable({
      isPackaged: false,
      nodeRuntime: unavailableNode,
      environment: { ...environment, NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: "node" },
    }),
  ).toThrow("absolute executable");
});

it("resolves development Agent Runtime from the existing build output", () => {
  expect(
    agentRuntimeEntrypoint({
      isPackaged: false,
      resourcesPath: "/unused",
      projectRootPath: "/checkout",
    }),
  ).toBe(path.join("/checkout", "out/agent-runtime/entry.mjs"));
});
