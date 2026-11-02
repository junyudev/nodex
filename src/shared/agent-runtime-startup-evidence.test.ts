import { expect, test } from "vite-plus/test";
import { parseAgentRuntimeStartupEvidence } from "./agent-runtime-startup-evidence";

const evidence = {
  schemaVersion: 1,
  runId: "isolated-run",
  hostPid: 42,
  runtimeId: "runtime",
  runtimeGeneration: "generation",
  nodeSource: "standalone",
  nodeVersion: "24.22.1",
};
const expected = { runId: evidence.runId, hostPid: evidence.hostPid };
test("startup evidence identifies the execution process's exact host generation", () => {
  expect(parseAgentRuntimeStartupEvidence(evidence, expected)).toEqual(evidence);
  expect(() => parseAgentRuntimeStartupEvidence({ ...evidence, hostPid: 43 }, expected)).toThrow(
    "another host generation",
  );
  expect(() =>
    parseAgentRuntimeStartupEvidence({ ...evidence, runId: "earlier-run" }, expected),
  ).toThrow("another host generation");
});
test("readiness requires an execution identity and excludes private connection fields", () => {
  expect(() =>
    parseAgentRuntimeStartupEvidence({ ...evidence, runtimeGeneration: "" }, expected),
  ).toThrow();
  expect(() =>
    parseAgentRuntimeStartupEvidence(
      { ...evidence, mcpEndpoint: "http://private/secret" },
      expected,
    ),
  ).toThrow();
});
