import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { expect, it } from "@effect/vitest";
import {
  hasTrustedWindowsOwner,
  WindowsDesktopTools,
  type WindowsDesktopToolsError,
  unsupportedWindowsDesktopTools,
  windowsDesktopToolsLayer,
} from "./WindowsDesktopTools";

it.effect("all Windows platform operations fail closed on a different OS", () =>
  Effect.gen(function* () {
    const tools = yield* WindowsDesktopTools;
    const root = { pid: 123, creationTime: "133812984900001234", imagePath: "child.exe" };
    const key = { browser: "chrome", host: "com.nodex.test", view: "x86" } as const;
    const installed = { kind: 1, dataHex: "0000" };
    const launch = { executable: "child.exe", cwd: ".", args: [], env: {} };
    const operations: readonly Effect.Effect<unknown, WindowsDesktopToolsError, Scope.Scope>[] = [
      tools.verifyAuthenticode("tool.exe"),
      tools.inspectPath("tool.exe"),
      tools.inspectPaths(["tool.exe"]),
      tools.ancestors(root),
      tools.listenPipe("nodex"),
      tools.connectPipe("endpoint"),
      tools.enumeratePipes("nodex", 1),
      tools.processIdentity(123),
      tools.descendants(root),
      tools.terminateSubtree(root),
      tools.spawnInJob(launch),
      tools.readRegistration(key),
      tools.writeRegistration(key, null, "manifest.json"),
      tools.restoreRegistration(key, { key, installed, previous: null, createdKey: true }),
    ];
    const result = yield* Effect.forEach(operations, Effect.flip);
    expect(result.map((error) => error.kind)).toEqual(Array(operations.length).fill("unsupported"));
  }).pipe(Effect.scoped, Effect.provide(windowsDesktopToolsLayer("darwin", ""))),
);

it.effect("a test layer can supply verification and path evidence without Windows", () => {
  const fake = Layer.succeed(WindowsDesktopTools, {
    ...unsupportedWindowsDesktopTools,
    verifyAuthenticode: (path) =>
      Effect.succeed(
        path === "signed.exe"
          ? {
              status: "verified",
              signature: "embedded",
              chain: [{ subject: "CN=Nodex Test", issuer: "CN=Test CA" }],
              codeSigningEku: true,
              timestampPresent: true,
              revocation: "cacheChecked",
            }
          : { status: "rejected", signature: "none", trustStatus: "0x800B0100" },
      ),
    inspectPath: () =>
      Effect.succeed({
        reparsePoint: false,
        ownerSid: "S-1-5-21-1",
        currentUserSid: "S-1-5-21-1",
        grantsForeignWrite: false,
      }),
  });
  return Effect.gen(function* () {
    const tools = yield* WindowsDesktopTools;
    const results = yield* Effect.all([
      tools.verifyAuthenticode("signed.exe"),
      tools.verifyAuthenticode("unsigned.exe"),
      tools.inspectPath("signed.exe"),
    ]);
    expect(results).toMatchObject([
      { status: "verified", chain: [{ subject: "CN=Nodex Test" }] },
      { status: "rejected", signature: "none" },
      { grantsForeignWrite: false },
    ]);
  }).pipe(Effect.provide(fake));
});

it("trusts the user, SYSTEM and Administrators as owners, and nobody else", () => {
  const currentUserSid = "S-1-5-21-1-2-3-1001";
  for (const ownerSid of [currentUserSid, "S-1-5-18", "S-1-5-32-544"])
    expect(hasTrustedWindowsOwner({ ownerSid, currentUserSid })).toBe(true);
  // Another interactive user, and the Users group, could plant files for this user.
  for (const ownerSid of ["S-1-5-21-1-2-3-1002", "S-1-5-32-545", "S-1-1-0"])
    expect(hasTrustedWindowsOwner({ ownerSid, currentUserSid })).toBe(false);
});
