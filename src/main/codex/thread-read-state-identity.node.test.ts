import { expect, it } from "vitest";
import {
  readThreadStateIdentity,
  readThreadStateIdentityFromAccount,
  threadReadStateHostKeys,
  threadReadStateIdentityKey,
} from "./thread-read-state-identity";

const token = (claims: Record<string, unknown>, exp: unknown = 1) =>
  `header.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": claims })).toString("base64url")}.signature`;
it("derives stable account and user claims without retaining authentication material", () => {
  const identity = readThreadStateIdentity({
    authMethod: "chatgpt",
    authToken: token({
      chatgpt_account_id: "account",
      account_id: "fallback",
      user_id: "user",
      chatgpt_user_id: "fallback-user",
    }),
    requiresOpenaiAuth: true,
  });
  expect(identity).toEqual({ kind: "chatgpt", accountId: "account", userId: "user" });
  expect(
    readThreadStateIdentity({
      authMethod: "chatgpt",
      authToken: token({ chatgpt_account_id: "account" }),
      requiresOpenaiAuth: true,
    }),
  ).toBeNull();
  expect(
    readThreadStateIdentity({
      authMethod: "chatgpt",
      authToken: token({ chatgpt_account_id: "account", user_id: "user" }, 0),
      requiresOpenaiAuth: true,
    }),
  ).toBeNull();
  expect(threadReadStateIdentityKey(identity!)).not.toEqual(
    threadReadStateIdentityKey({ kind: "chatgpt", accountId: "account", userId: "other" }),
  );
});
it("distinguishes unauthenticated unavailable storage from explicitly unauthenticated execution storage", () => {
  expect(
    readThreadStateIdentity({ authMethod: null, authToken: null, requiresOpenaiAuth: true }),
  ).toBeNull();
  expect(
    readThreadStateIdentity({ authMethod: null, authToken: null, requiresOpenaiAuth: false }),
  ).toEqual({ kind: "execution-storage", authMode: "none" });
  expect(threadReadStateHostKeys([]).local).toMatch(/^local:[0-9a-f]{64}$/);
});

it("resolves storage-backed identities from account/read without legacy auth tokens", () => {
  expect(
    readThreadStateIdentityFromAccount({
      account: { type: "apiKey" },
      requiresOpenaiAuth: false,
    }),
  ).toEqual({ kind: "execution-storage", authMode: "apikey" });
  expect(readThreadStateIdentityFromAccount({ account: null, requiresOpenaiAuth: false })).toEqual({
    kind: "execution-storage",
    authMode: "none",
  });
  expect(
    readThreadStateIdentityFromAccount({
      account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
      requiresOpenaiAuth: true,
    }),
  ).toBeNull();
});

it("keys SSH read state by the physical connection while ignoring product storage paths", () => {
  const host = {
    id: "remote",
    displayName: "Remote",
    kind: "ssh" as const,
    sshAlias: "devbox",
    port: null,
    managedRoot: "/worktrees",
    repositoryRoots: ["/repo"],
    codexBinary: null,
    codexHome: null,
    enabled: true,
  };
  const original = threadReadStateHostKeys([host]).remote;
  expect(
    threadReadStateHostKeys([{ ...host, codexHome: "/other", managedRoot: "/elsewhere" }]).remote,
  ).toBe(original);
  expect(threadReadStateHostKeys([{ ...host, sshAlias: "another" }]).remote).not.toBe(original);
  expect(threadReadStateHostKeys([{ ...host, port: 2222 }]).remote).not.toBe(original);
  expect(threadReadStateHostKeys([{ ...host, enabled: false }]).remote).toBeUndefined();
});
