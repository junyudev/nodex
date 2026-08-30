import { describe, expect, it } from "vite-plus/test";
import {
  createBoundedOperationId,
  encodeBoundedOperationId,
  isBoundedOperationId,
  OPERATION_IDENTITY_WINDOW_MS,
} from "./operation-identity";

describe("bounded operation identity", () => {
  it("creates a browser-safe random identity with one exact receipt window", () => {
    const issuedAt = 1_800_000_000_000;
    const operationId = createBoundedOperationId(" Workspace.Project Rename ", issuedAt);

    expect(operationId).toMatch(
      /^nodexop:v1:1800000000000:1800604800000:workspace\.project-rename:[0-9a-f-]{36}$/u,
    );
    expect(isBoundedOperationId(operationId)).toBe(true);
  });

  it("shares the canonical encoder with stable Node-owned entropy", () => {
    const issuedAt = 1_800_000_000_000;
    const operationId = encodeBoundedOperationId("Agent/Create Pages", issuedAt, "a".repeat(64));

    expect(operationId).toBe(
      `nodexop:v1:${issuedAt}:${issuedAt + OPERATION_IDENTITY_WINDOW_MS}:agent-create-pages:${"a".repeat(64)}`,
    );
    expect(isBoundedOperationId(operationId)).toBe(true);
  });

  it("rejects malformed envelopes without applying expiry policy at the renderer boundary", () => {
    expect(isBoundedOperationId("operation:legacy")).toBe(false);
    expect(isBoundedOperationId("nodexop:v1:100:101:test:entropy")).toBe(false);
    expect(isBoundedOperationId("nodexop:v1:100:604800100:Bad Scope:entropy")).toBe(false);
    expect(isBoundedOperationId("nodexop:v1:100:604800100:test:entropy:extra")).toBe(false);
  });
});
