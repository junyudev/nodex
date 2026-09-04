import path from "node:path";

import { expect, test } from "vite-plus/test";

import { verifyCall, verifyDeclaredReferences } from "./verify-reusable-workflow-secrets";

const reusableWorkflow = (
  jobs: Record<string, unknown>,
  inputs: Record<string, unknown> = {},
): Record<string, unknown> => ({
  jobs,
  on: {
    workflow_call: {
      inputs,
      secrets: {
        DECLARED_SECRET: { required: true },
      },
    },
  },
});

test("allows the Sparkle signing key only in a direct protected environment job", () => {
  const filePath = path.resolve(".github/workflows/test.yml");
  const directWorkflow = (jobs: Record<string, unknown>): Record<string, unknown> => ({
    jobs,
    on: { workflow_dispatch: {} },
  });

  expect(() =>
    verifyDeclaredReferences(
      filePath,
      directWorkflow({
        finalize: {
          environment: "sparkle-feed-finalization",
          steps: [{ env: { KEY: "${{ secrets.SPARKLE_ED25519_PRIVATE_KEY }}" } }],
        },
      }),
    ),
  ).not.toThrow();

  expect(() =>
    verifyDeclaredReferences(
      filePath,
      directWorkflow({
        assemble: {
          steps: [{ env: { KEY: "${{ secrets.SPARKLE_ED25519_PRIVATE_KEY }}" } }],
        },
      }),
    ),
  ).toThrow("assemble references protected environment secrets outside their environment");

  expect(() =>
    verifyDeclaredReferences(
      filePath,
      reusableWorkflow({
        finalize: {
          environment: "sparkle-feed-finalization",
          steps: [{ env: { KEY: "${{ secrets.SPARKLE_ED25519_PRIVATE_KEY }}" } }],
        },
      }),
    ),
  ).toThrow("must not resolve protected environment secrets across a reusable workflow boundary");
});

test("rejects transporting a protected environment secret from a caller", () => {
  const callerPath = path.resolve(".github/workflows/caller.yml");
  const calledPath = path.resolve(".github/workflows/called.yml");
  const calledWorkflow = reusableWorkflow({ publish: { steps: [] } });

  expect(() =>
    verifyCall(
      callerPath,
      "distribution",
      {
        uses: "./.github/workflows/called.yml",
        secrets: {
          SPARKLE_ED25519_PRIVATE_KEY: "${{ secrets.SPARKLE_ED25519_PRIVATE_KEY }}",
        },
      },
      new Map([[calledPath, calledWorkflow]]),
    ),
  ).toThrow("must resolve protected environment secrets in the called job");
});

test("rejects missing and undeclared reusable workflow inputs", () => {
  const callerPath = path.resolve(".github/workflows/caller.yml");
  const calledPath = path.resolve(".github/workflows/called.yml");
  const calledWorkflow = reusableWorkflow(
    { run: { steps: [] } },
    { source_sha: { required: true, type: "string" } },
  );
  const workflows = new Map([[calledPath, calledWorkflow]]);

  expect(() =>
    verifyCall(
      callerPath,
      "certify",
      {
        uses: "./.github/workflows/called.yml",
        secrets: { DECLARED_SECRET: "${{ secrets.DECLARED_SECRET }}" },
      },
      workflows,
    ),
  ).toThrow("omits required inputs: source_sha");

  expect(() =>
    verifyCall(
      callerPath,
      "certify",
      {
        uses: "./.github/workflows/called.yml",
        with: { source_sha: "abc", surprise: true },
        secrets: { DECLARED_SECRET: "${{ secrets.DECLARED_SECRET }}" },
      },
      workflows,
    ),
  ).toThrow("passes undeclared inputs: surprise");
});

test("rejects reusable workflow permission escalation before GitHub startup", () => {
  const callerPath = path.resolve(".github/workflows/caller.yml");
  const calledPath = path.resolve(".github/workflows/called.yml");
  const calledWorkflow = {
    ...reusableWorkflow({ run: { steps: [] } }),
    permissions: { actions: "read", contents: "read" },
  };
  const callerJob = {
    uses: "./.github/workflows/called.yml",
    secrets: { DECLARED_SECRET: "${{ secrets.DECLARED_SECRET }}" },
  };
  const callerWorkflow = {
    jobs: { call: callerJob },
    on: { workflow_dispatch: {} },
    permissions: { contents: "read" },
  };
  const workflows = new Map<string, Record<string, unknown>>([
    [callerPath, callerWorkflow],
    [calledPath, calledWorkflow],
  ]);

  expect(() => verifyCall(callerPath, "call", callerJob, workflows)).toThrow(
    "does not grant permissions required by the called workflow: actions",
  );

  const permittedCaller = {
    ...callerWorkflow,
    permissions: { actions: "read", contents: "read" },
  };
  expect(() =>
    verifyCall(
      callerPath,
      "call",
      callerJob,
      new Map([
        [callerPath, permittedCaller],
        [calledPath, calledWorkflow],
      ]),
    ),
  ).not.toThrow();
});
