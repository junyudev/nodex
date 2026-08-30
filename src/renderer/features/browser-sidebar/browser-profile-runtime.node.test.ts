import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_BROWSER_USE_POLICY } from "../../../shared/browser-use-policy";
import { createBrowserUsePolicyOwner, type BrowserUsePolicyPort } from "./browser-profile-runtime";
import {
  createRendererCausalTrace,
  recordRendererOwnerTrace,
} from "../../lib/renderer-causal-trace";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("BrowserUsePolicyOwner", () => {
  it("presents composed cross-kind intent while serializing partial policy commands", async () => {
    const requestA = deferred<typeof DEFAULT_BROWSER_USE_POLICY>();
    const requestB = deferred<typeof DEFAULT_BROWSER_USE_POLICY>();
    const sentKinds: string[] = [];
    const trace = createRendererCausalTrace({ enabled: true });
    const port: BrowserUsePolicyPort = {
      read: async () => DEFAULT_BROWSER_USE_POLICY,
      update: async (command, context) => {
        sentKinds.push(command.kind);
        recordRendererOwnerTrace(context, { kind: "submitted", reason: "transport_submit" }, trace);
        const result = await (command.kind === "modes" ? requestA.promise : requestB.promise);
        recordRendererOwnerTrace(context, { kind: "result", reason: "terminal_result" }, trace);
        return result;
      },
    };
    let operationSequence = 0;
    const owner = createBrowserUsePolicyOwner({
      port,
      operationId: () => `browser-policy-${++operationSequence}`,
      trace,
    });

    const updateA = owner.updateModes({ approvalMode: "neverAsk" });
    const updateB = owner.updateOriginRule({
      action: "add",
      kind: "allowed",
      origin: "example.com/path",
      resource: "origin",
    });
    const renderTokenB = owner.getSnapshot().renderToken;
    expect(owner.getSnapshot()).toMatchObject({
      pending: true,
      value: {
        approvalMode: "neverAsk",
        allowedOrigins: ["https://example.com"],
      },
    });
    await Promise.resolve();
    expect(sentKinds).toEqual(["modes"]);

    requestA.resolve({ ...DEFAULT_BROWSER_USE_POLICY, approvalMode: "neverAsk" });
    await expect(updateA).resolves.toMatchObject({
      approvalMode: "neverAsk",
      allowedOrigins: ["https://example.com"],
    });
    expect(sentKinds).toEqual(["modes", "origin_rule"]);
    requestB.resolve({
      ...DEFAULT_BROWSER_USE_POLICY,
      approvalMode: "neverAsk",
      allowedOrigins: ["https://example.com"],
    });
    await updateB;
    owner.markRendered(renderTokenB ?? 0);

    expect(owner.getSnapshot()).toMatchObject({
      pending: false,
      value: {
        approvalMode: "neverAsk",
        allowedOrigins: ["https://example.com"],
      },
    });
    expect(trace.reduce()).toMatchObject({
      legal: true,
      operations: [{ outcome: "superseded" }, { outcome: "settled" }],
    });
  });

  it("projects a normalized origin rule before transport", async () => {
    let policyAtSend = DEFAULT_BROWSER_USE_POLICY;
    let owner!: ReturnType<typeof createBrowserUsePolicyOwner>;
    const port: BrowserUsePolicyPort = {
      read: async () => DEFAULT_BROWSER_USE_POLICY,
      update: async () => {
        policyAtSend = owner.getSnapshot().value;
        return policyAtSend;
      },
    };
    owner = createBrowserUsePolicyOwner({ port, operationId: () => "browser-policy-origin" });

    await owner.updateOriginRule({
      action: "add",
      kind: "allowed",
      origin: "example.com/path",
      resource: "origin",
    });

    expect(policyAtSend.allowedOrigins).toEqual(["https://example.com"]);
  });
});
