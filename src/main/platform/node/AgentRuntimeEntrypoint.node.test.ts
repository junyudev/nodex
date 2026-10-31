import { expect, it } from "vite-plus/test";
import {
  agentRuntimeEntrypoint,
  agentRuntimeNodeExecutable,
  scenarioAgentRuntimeProjectRoot,
} from "./AgentRuntimeEntrypoint";

it("keeps packaged execution outside ASAR and ignores every test executable override", () => {
  expect(
    agentRuntimeEntrypoint({
      isPackaged: true,
      resourcesPath: "/resources",
      projectRootPath: "/repo",
    }),
  ).toBe("/resources/app.asar.unpacked/out/agent-runtime/entry.mjs");
  expect(
    agentRuntimeNodeExecutable({
      isPackaged: true,
      bundledExecutable: "/verified/node",
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
    agentRuntimeNodeExecutable({ isPackaged: false, bundledExecutable: null, environment }),
  ).toBe(process.execPath);
  expect(scenarioAgentRuntimeProjectRoot({ isPackaged: true, environment })).toBeUndefined();
  expect(
    agentRuntimeNodeExecutable({
      isPackaged: true,
      bundledExecutable: "/verified/node",
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
      bundledExecutable: null,
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
    agentRuntimeNodeExecutable({ isPackaged: false, bundledExecutable: null, environment }),
  ).toBe(process.execPath);
  for (const changed of [
    { ...environment, NODE_ENV: "development" },
    { ...environment, NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: "" },
  ])
    expect(() =>
      agentRuntimeNodeExecutable({
        isPackaged: false,
        bundledExecutable: null,
        environment: changed,
      }),
    ).toThrow("verified Node");
  expect(() =>
    agentRuntimeNodeExecutable({
      isPackaged: false,
      bundledExecutable: null,
      environment: { ...environment, NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: "node" },
    }),
  ).toThrow("absolute executable");
});
