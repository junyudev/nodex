import { expect, it } from "vitest";
import { makeAuthOutputRedactor } from "../../vendor/provider-acp-registry/src/server/authOutput.ts";

it("keeps ordinary prompts visible and never publishes split secret prefixes", () => {
  const secret = "sk-private-token-123456";
  for (let boundary = 1; boundary < secret.length; boundary++) {
    const redact = makeAuthOutputRedactor([secret]);
    expect(redact.push(`Sign in: ${secret.slice(0, boundary)}`)).toBe("Sign in: ");
    expect(redact.push(`${secret.slice(boundary)}\r\nEnter code: `)).toBe(
      "[redacted]\r\nEnter code: ",
    );
    expect(redact.finish()).toBe("");
  }
});

it("handles overlapping secrets, repeated values and an incomplete secret at process exit", () => {
  const redact = makeAuthOutputRedactor(["secret", "secret-long", "secret", ""]);
  expect(redact.push("secret")).toBe("");
  expect(redact.push("-long secret ")).toBe("[redacted] [redacted] ");
  expect(redact.push("secr")).toBe("");
  expect(redact.finish()).toBe("[redacted]");
  expect(redact.push("Next prompt: ")).toBe("Next prompt: ");
});
