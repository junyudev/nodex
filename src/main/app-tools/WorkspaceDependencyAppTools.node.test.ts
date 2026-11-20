import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { afterEach } from "vite-plus/test";
import type { AppComponents } from "../app-components/AppComponents";
import { writeAppComponentReceipt } from "../app-components/AppComponentStore";
import { writeDocumentToolsFixture } from "../platform/node/document-tools-test-fixture";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { live, WorkspaceDependencyRuntime } from "../host-runtime/WorkspaceDependencyRuntime";
import { make } from "./WorkspaceDependencyAppTools";
import type { AppToolInvocation } from "./AppToolInvocationInbox";

const invocation: AppToolInvocation = {
  name: "load_workspace_dependencies",
  arguments: {},
  caller: {
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
};

it.effect(
  "allows dependency inspection in a read-only Turn but requires current calling authority",
  () =>
    Effect.gen(function* () {
      let authorized = true;
      let active = true;
      let reads = 0;
      const execute = yield* make.pipe(
        Effect.provideService(CodexTurnAuthority, {
          capture: () => Effect.succeed(authorized ? { readOnly: true } : null),
        } as never),
        Effect.provideService(WorkspaceDependencyRuntime, {
          read: Effect.sync(() => {
            reads++;
            return { status: "unavailable" as const, reason: "not_installed" as const };
          }),
        }),
      );
      const input = { ...invocation, caller: { ...invocation.caller, isActive: () => active } };
      assert.deepEqual((yield* execute(input)).structuredContent, {
        status: "unavailable",
        reason: "not_installed",
      });
      assert.strictEqual(reads, 1);
      authorized = false;
      assert.deepEqual((yield* execute(input)).structuredContent, {
        error: { code: "authority_unavailable" },
      });
      active = false;
      assert.deepEqual((yield* execute(input)).structuredContent, {
        error: { code: "call_withdrawn" },
      });
      assert.strictEqual(reads, 1);
    }),
);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const executeWithDocumentTools = Effect.fnUntraced(function* (
  ensure: AppComponents["Service"]["ensure"],
) {
  const root = mkdtempSync(join(tmpdir(), "nodex-workspace-tool-"));
  roots.push(root);
  const { payload, unpackedBytes, manifest } = writeDocumentToolsFixture(root);
  yield* Effect.promise(() => writeAppComponentReceipt(root, unpackedBytes));
  const execute = yield* make.pipe(
    Effect.provideService(CodexTurnAuthority, {
      capture: () => Effect.succeed({ readOnly: true }),
    } as never),
    Effect.provide(
      live(
        {
          root: null,
          platform: "darwin",
          arch: "arm64",
          node: { executable: "/node", version: "24" },
        },
        {
          manifestSha256: payload.manifestSha256,
          ensure: (id) =>
            ensure(id).pipe(
              Effect.map((value) => (value.status === "installed" ? { ...value, root } : value)),
            ),
        },
      ),
    ),
  );
  return { call: execute(invocation), python: join(root, manifest.pythonExecutable) };
});

const installed = { status: "installed", root: "" } as const;

it.effect("the first tool call requests Document Tools and uses the installed path", () =>
  Effect.gen(function* () {
    const requested: string[] = [];
    const { call, python } = yield* executeWithDocumentTools((id) =>
      Effect.sync(() => {
        requested.push(id);
        return installed;
      }),
    );
    assert.deepEqual(requested, []);
    assert.deepInclude((yield* call).structuredContent, {
      status: "available",
      python: {
        executable: python,
        version: "3.13.15",
        recommendedArgs: ["-I", "-B"],
        sitePackages: join(python, "../../lib/python3.13/site-packages"),
      },
    });
    assert.deepEqual(requested, ["document-tools"]);
  }),
);

it.effect("bounds the installation wait and lets a subsequent call obtain Document Tools", () =>
  Effect.gen(function* () {
    let ready = false;
    const { call } = yield* executeWithDocumentTools(() =>
      Effect.suspend(() => (ready ? Effect.succeed(installed) : Effect.never)),
    );
    const pending = yield* Effect.forkChild(call);
    yield* TestClock.adjust("3 minutes");
    const result = yield* Fiber.join(pending);
    const expected = {
      status: "unavailable",
      reason: "installing",
      message: "Document Tools are still downloading. Retry shortly.",
    };
    assert.deepEqual(result.structuredContent, expected);
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(expected) }]);
    ready = true;
    assert.strictEqual((yield* call).structuredContent?.status, "available");
  }),
);

it.effect("checks the Component switch even after successful use", () =>
  Effect.gen(function* () {
    let enabled = true;
    const { call } = yield* executeWithDocumentTools(() =>
      Effect.sync(() =>
        enabled ? installed : { status: "unavailable", reason: "turned-off", message: "Off" },
      ),
    );
    assert.strictEqual((yield* call).structuredContent?.status, "available");
    enabled = false;
    assert.deepEqual((yield* call).structuredContent, {
      status: "unavailable",
      reason: "not_installed",
      message: "Document Tools are turned off in Settings → General → Components.",
    });
  }),
);

it.effect("does not cache a failed installation", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const { call } = yield* executeWithDocumentTools(() =>
      Effect.sync(() => {
        attempts++;
        return attempts === 1
          ? { status: "unavailable", reason: "failed", message: "Failed" }
          : installed;
      }),
    );
    assert.deepEqual((yield* call).structuredContent, {
      status: "unavailable",
      reason: "invalid_bundle",
    });
    assert.strictEqual((yield* call).structuredContent?.status, "available");
  }),
);
