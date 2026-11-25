import { describe, vi, expect, test, afterEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { assert, it } from "@effect/vitest";
import { makeBrowserCredentialRuntime } from "./browser-credential-service";
import { BrowserCredentialVault } from "./browser-credential-vault";
import {
  type BrowserProfileHelperRequest,
  BrowserProfileHelperPlatform,
  resolveBrowserProfileHelperExecutable,
} from "./browser-profile-helper-client";
import {
  makeBrowserProfileImportRuntime,
  type BrowserProfileImportRuntimeOptions,
} from "./browser-profile-importer";
import * as TestClock from "effect/testing/TestClock";
import * as BrowserProfileHelperNode from "../platform/node/BrowserProfileHelperNode";
import type { BrowserSidebarTabIdentity } from "../../shared/browser-sidebar";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeBrowserPageRuntime, type BrowserSerializedPage } from "./browser-page-store";
import { makeBrowserHistoryRuntime } from "./browser-history-store";

describe("browser-profile-importer", () => {
  describe("browser-profile-importer", () => {
    const makeSourceRoot = (source: "atlas" | "chrome") => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `nodex-${source}-profile-`));
      const profilePath = path.join(root, "Default");
      fs.mkdirSync(profilePath);
      fs.writeFileSync(path.join(profilePath, "Cookies"), "fixture");
      fs.writeFileSync(path.join(profilePath, "Login Data"), "fixture");
      fs.writeFileSync(
        path.join(root, "Local State"),
        JSON.stringify({
          profile: {
            info_cache: {
              Default: {
                name: source === "atlas" ? "Your ChatGPT Atlas" : "Person 1",
                gaia_name: "Example Person",
                user_name: "person@example.com",
              },
            },
          },
        }),
      );
      return { root, profilePath: fs.realpathSync(profilePath) };
    };

    const makeVault = (root: string) =>
      new BrowserCredentialVault({
        filePath: path.join(root, "vault.json"),
        encryption: {
          isAvailable: () => true,
          encryptString: (value) => Buffer.from(`secure:${value}`),
          decryptString: (value) => value.toString().slice("secure:".length),
        },
      });

    const makeCredentials = (vault: BrowserCredentialVault) =>
      makeBrowserCredentialRuntime({
        vault,
        resolveGuest: () => null,
        resolveGuestIdentity: () => null,
        resolveGuestOwner: () => null,
      });

    const withRoots = <A, E, R>(
      run: (root: string) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "nodex-profile-import-runtime-"))),
        run,
        (root) => Effect.sync(() => fs.rmSync(root, { recursive: true, force: true })),
      );

    it.effect("discovers only concrete Chrome and Atlas profiles with available data", () =>
      withRoots((root) =>
        Effect.scoped(
          Effect.gen(function* () {
            const chrome = makeSourceRoot("chrome");
            const atlas = makeSourceRoot("atlas");
            try {
              const credentials = yield* makeCredentials(makeVault(root));
              const runtime = yield* makeBrowserProfileImportRuntime({
                cookieStore: { get: async () => [], set: async () => undefined },
                credentials,
                helper: { readProfile: () => Effect.die("unused") },
                homeDirectory: root,
                platform: "darwin",
                sourceRoots: { chrome: chrome.root, atlas: atlas.root },
              });
              const profiles = yield* runtime.listProfiles;
              assert.lengthOf(profiles, 2);
              assert.deepInclude(profiles[0], {
                source: "atlas",
                profileName: "Your ChatGPT Atlas",
                profilePath: atlas.profilePath,
                hasCookies: true,
                hasPasswords: true,
              });
              assert.deepInclude(profiles[1], {
                source: "chrome",
                profileName: "Person 1",
                profilePath: chrome.profilePath,
                hasCookies: true,
                hasPasswords: true,
              });
            } finally {
              fs.rmSync(chrome.root, { recursive: true, force: true });
              fs.rmSync(atlas.root, { recursive: true, force: true });
            }
          }),
        ),
      ),
    );

    it.effect("imports cookies and passwords through their unique authorities", () =>
      withRoots((root) =>
        Effect.scoped(
          Effect.gen(function* () {
            const chrome = makeSourceRoot("chrome");
            try {
              const vault = makeVault(root);
              const credentials = yield* makeCredentials(vault);
              const setCookie = vi.fn(
                async (
                  _details: Parameters<BrowserProfileImportRuntimeOptions["cookieStore"]["set"]>[0],
                ) => undefined,
              );
              const readProfile = vi.fn((_request: BrowserProfileHelperRequest) =>
                Effect.succeed({
                  schemaVersion: 1 as const,
                  ok: true,
                  cookies: [
                    {
                      domain: ".example.com",
                      name: "session",
                      value: "cookie-secret",
                      path: "/",
                      secure: true,
                      httpOnly: true,
                      expirationDate: 2_000_000_000,
                      sameSite: "lax" as const,
                    },
                  ],
                  credentials: [
                    {
                      origin: "https://example.com",
                      username: "person",
                      password: "password-secret",
                    },
                  ],
                  cookieFailures: 0,
                  passwordFailures: 0,
                  errorCode: null,
                }),
              );
              const runtime = yield* makeBrowserProfileImportRuntime({
                cookieStore: { get: async () => [], set: setCookie },
                credentials,
                helper: { readProfile },
                homeDirectory: root,
                platform: "darwin",
                sourceRoots: { chrome: chrome.root, atlas: "/missing" },
                now: () => 1_800_000_000_000,
              });

              const result = yield* runtime.importProfile({
                source: "chrome",
                profilePath: chrome.profilePath,
                importCookies: true,
                importPasswords: true,
                cookieDomainAllowlist: ["example.com"],
              });
              assert.deepInclude(readProfile.mock.calls[0]?.[0], {
                cookieDomainAllowlist: ["example.com"],
              });
              assert.deepInclude(setCookie.mock.calls[0]?.[0], {
                url: "https://example.com/",
                value: "cookie-secret",
              });
              assert.lengthOf(vault.listForOrigin("https://example.com"), 1);
              assert.deepInclude(result.cookies, { imported: 1, status: "success" });
              assert.deepInclude(result.passwords, { imported: 1, status: "success" });
              assert.deepEqual(fs.readdirSync(chrome.root), ["Default", "Local State"]);
            } finally {
              fs.rmSync(chrome.root, { recursive: true, force: true });
            }
          }),
        ),
      ),
    );

    it.effect("serializes imports before starting the profile helper", () =>
      withRoots((root) =>
        Effect.scoped(
          Effect.gen(function* () {
            const chrome = makeSourceRoot("chrome");
            try {
              const firstEntered = yield* Deferred.make<void>();
              const releaseFirst = yield* Deferred.make<void>();
              const credentials = yield* makeCredentials(makeVault(root));
              let calls = 0;
              let active = 0;
              let maxActive = 0;
              const response = {
                schemaVersion: 1 as const,
                ok: true,
                cookies: [],
                credentials: [],
                cookieFailures: 0,
                passwordFailures: 0,
                errorCode: null,
              };
              const runtime = yield* makeBrowserProfileImportRuntime({
                cookieStore: { get: async () => [], set: async () => undefined },
                credentials,
                helper: {
                  readProfile: () =>
                    Effect.acquireUseRelease(
                      Effect.sync(() => {
                        calls += 1;
                        active += 1;
                        maxActive = Math.max(maxActive, active);
                        return calls;
                      }),
                      (call) =>
                        call === 1
                          ? Deferred.succeed(firstEntered, undefined).pipe(
                              Effect.andThen(Deferred.await(releaseFirst)),
                              Effect.as(response),
                            )
                          : Effect.succeed(response),
                      () => Effect.sync(() => void (active -= 1)),
                    ),
                },
                homeDirectory: root,
                platform: "darwin",
                sourceRoots: { chrome: chrome.root, atlas: "/missing" },
              });
              const input = {
                source: "chrome" as const,
                profilePath: chrome.profilePath,
                importCookies: true,
                importPasswords: false,
              };
              const first = yield* Effect.forkChild(runtime.importProfile(input), {
                startImmediately: true,
              });
              yield* Deferred.await(firstEntered);
              const second = yield* Effect.forkChild(runtime.importProfile(input), {
                startImmediately: true,
              });
              yield* Effect.yieldNow;
              assert.strictEqual(calls, 1);
              assert.strictEqual(maxActive, 1);

              yield* Deferred.succeed(releaseFirst, undefined);
              yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
              assert.strictEqual(calls, 2);
              assert.strictEqual(maxActive, 1);
            } finally {
              fs.rmSync(chrome.root, { recursive: true, force: true });
            }
          }),
        ),
      ),
    );

    it.effect("refuses live or renderer-substituted profiles before invoking the helper", () =>
      withRoots((root) =>
        Effect.scoped(
          Effect.gen(function* () {
            const chrome = makeSourceRoot("chrome");
            try {
              fs.symlinkSync("host-42", path.join(chrome.root, "SingletonLock"));
              const credentials = yield* makeCredentials(makeVault(root));
              const readProfile = vi.fn((_request: BrowserProfileHelperRequest) =>
                Effect.die("unused"),
              );
              const runtime = yield* makeBrowserProfileImportRuntime({
                cookieStore: { get: async () => [], set: async () => undefined },
                credentials,
                helper: { readProfile },
                homeDirectory: root,
                platform: "darwin",
                sourceRoots: { chrome: chrome.root, atlas: "/missing" },
                isProcessAlive: (pid) => pid === 42,
              });

              const liveError = yield* runtime
                .importProfile({
                  source: "chrome",
                  profilePath: chrome.profilePath,
                  importCookies: true,
                  importPasswords: false,
                })
                .pipe(Effect.flip);
              assert.include(String(liveError.cause), "Close Google Chrome");

              fs.unlinkSync(path.join(chrome.root, "SingletonLock"));
              const pathError = yield* runtime
                .importProfile({
                  source: "chrome",
                  profilePath: path.join(chrome.root, "..", "other"),
                  importCookies: true,
                  importPasswords: false,
                })
                .pipe(Effect.flip);
              assert.include(String(pathError.cause), "no longer importable");
              assert.lengthOf(readProfile.mock.calls, 0);
            } finally {
              fs.rmSync(chrome.root, { recursive: true, force: true });
            }
          }),
        ),
      ),
    );
  });

  describe("browser-profile-helper-client", () => {
    describe("resolveBrowserProfileHelperExecutable", () => {
      test("resolves explicit, packaged, and development executables", () => {
        expect(
          resolveBrowserProfileHelperExecutable({
            environment: {
              NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE: "/opt/nodex/bin/profile-helper",
            },
            isPackaged: false,
            repositoryRoot: "/work/nodex",
            resourcesPath: "/electron/resources",
          }),
        ).toBe(path.normalize("/opt/nodex/bin/profile-helper"));
        expect(
          resolveBrowserProfileHelperExecutable({
            environment: {},
            isPackaged: true,
            repositoryRoot: "/work/nodex",
            resourcesPath: "/Applications/Nodex.app/Contents/Resources",
          }),
        ).toBe(
          path.join(
            "/Applications/Nodex.app/Contents/Resources",
            "bin",
            "nodex-browser-profile-helper",
          ),
        );
        expect(
          resolveBrowserProfileHelperExecutable({
            environment: {},
            isPackaged: false,
            repositoryRoot: "/work/nodex",
            resourcesPath: "/electron/resources",
          }),
        ).toBe(path.join("/work/nodex", "target/debug/nodex-browser-profile-helper"));
      });

      test("rejects a relative executable override", () => {
        expect(() =>
          resolveBrowserProfileHelperExecutable({
            environment: {
              NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE: "target/release/profile-helper",
            },
            isPackaged: false,
            repositoryRoot: "/work/nodex",
            resourcesPath: "/electron/resources",
          }),
        ).toThrow("NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE must be absolute");
      });
    });

    it.layer(BrowserProfileHelperNode.nodeLive)("Browser Profile helper runtime", (it) => {
      // The shipped Browser Profile helper is macOS-only; Windows child lifetime is covered by NodeChildProcessSpawner.
      it.effect.skipIf(process.platform === "win32")(
        "kills the scoped helper child when its Effect deadline expires",
        () =>
          Effect.acquireUseRelease(
            Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "nodex-profile-helper-test-"))),
            (root) =>
              Effect.gen(function* () {
                const pidPath = path.join(root, "helper.pid");
                const executablePath = path.join(root, "helper.mjs");
                fs.writeFileSync(
                  executablePath,
                  `#!/usr/bin/env node
import fs from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  fs.writeFileSync(request.profilePath, String(process.pid));
  setInterval(() => undefined, 1_000);
});
`,
                  { mode: 0o700 },
                );
                const platform = yield* BrowserProfileHelperPlatform;
                const helper = platform.make({ executablePath, timeoutMs: 50 });
                const pending = yield* Effect.forkChild(
                  helper.readProfile({
                    source: "chrome",
                    profilePath: pidPath,
                    includeCookies: true,
                    includePasswords: false,
                  }),
                  { startImmediately: true },
                );
                yield* Effect.promise(() => expect.poll(() => fs.existsSync(pidPath)).toBe(true));
                const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8"), 10);
                yield* TestClock.adjust("50 millis");
                const error = yield* Fiber.join(pending).pipe(Effect.flip);
                assert.strictEqual(error.operation, "timeout");
                assert.throws(() => process.kill(pid, 0));
              }),
            (root) => Effect.sync(() => fs.rmSync(root, { recursive: true, force: true })),
          ),
      );
    });
  });
});

describe("browser-credential-service", () => {
  describe("browser-credential-service", () => {
    const identity: BrowserSidebarTabIdentity = {
      browserConversationId: "conversation",
      browserViewScopeId: "scope",
      browserTabId: "tab",
    };
    const roots: string[] = [];

    afterEach(() => {
      for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    });

    const makeVault = () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-credential-runtime-"));
      roots.push(root);
      return new BrowserCredentialVault({
        filePath: path.join(root, "vault.json"),
        encryption: {
          isAvailable: () => true,
          encryptString: (value) => Buffer.from(`secure:${value}`),
          decryptString: (value) => value.toString().slice("secure:".length),
        },
      });
    };

    const makeHarness = Effect.gen(function* () {
      const vault = makeVault();
      const send = vi.fn();
      let url = "https://example.com/login?private=1";
      const guest = { id: 42, getURL: () => url, isDestroyed: () => false, send };
      const runtime = yield* makeBrowserCredentialRuntime({
        vault,
        resolveGuest: (candidate) =>
          candidate.browserTabId === identity.browserTabId ? guest : null,
        resolveGuestIdentity: (guestId) => (guestId === 42 ? identity : null),
        resolveGuestOwner: (guestId) => (guestId === 42 ? 7 : null),
        now: () => 1_000,
      });
      return {
        runtime,
        send,
        setUrl: (value: string) => {
          url = value;
        },
        vault,
      };
    });

    it.effect("treats an unattached Browser page as having no site credentials", () =>
      Effect.gen(function* () {
        const vault = makeVault();
        vault.save({ origin: "https://example.com", username: "person", password: "top-secret" });
        const runtime = yield* makeBrowserCredentialRuntime({
          vault,
          resolveGuest: () => null,
          resolveGuestIdentity: () => null,
          resolveGuestOwner: () => null,
        });
        assert.deepEqual(yield* runtime.listForTab(identity), []);
      }),
    );

    it.effect(
      "keeps candidate plaintext out of renderer events and persists authorized saves",
      () =>
        Effect.gen(function* () {
          const { runtime } = yield* makeHarness;
          const candidate = yield* runtime.captureGuestCandidate(42, {
            username: "person@example.com",
            password: "top-secret",
          });
          assert.deepInclude(candidate, {
            ...identity,
            origin: "https://example.com",
            username: "person@example.com",
          });
          assert.notInclude(JSON.stringify(candidate), "top-secret");
          assert.deepEqual(
            yield* runtime.actOnCandidate(7, {
              candidateId: candidate!.candidateId,
              action: "save",
            }),
            { ok: true },
          );
          assert.lengthOf(yield* runtime.listForTab(identity), 1);
        }),
    );

    it.effect("sends decrypted fill data only to the exact guest origin", () =>
      Effect.gen(function* () {
        const { runtime, send, setUrl, vault } = yield* makeHarness;
        const summary = vault.save({
          origin: "https://example.com",
          username: "person",
          password: "top-secret",
        });
        assert.deepEqual(yield* runtime.fill({ ...identity, credentialId: summary.id }), {
          ok: true,
        });
        assert.deepEqual(send.mock.calls[0], [
          "browser-credential-fill",
          {
            origin: "https://example.com",
            username: "person",
            password: "top-secret",
            kind: "saved",
          },
        ]);
        setUrl("https://other.example");
        assert.isFalse((yield* runtime.fill({ ...identity, credentialId: summary.id })).ok);
        assert.lengthOf(send.mock.calls, 1);
      }),
    );

    it.effect("fills encrypted contact info directly into the exact guest", () =>
      Effect.gen(function* () {
        const { runtime, send } = yield* makeHarness;
        const contact = yield* runtime.saveContactInfo({
          label: "Home",
          fullName: "Example Person",
          email: "person@example.com",
          phone: "+86 123",
          addressLine1: "1 Private Street",
          addressLine2: "",
          city: "Shanghai",
          region: "Shanghai",
          postalCode: "200000",
          country: "China",
        });
        assert.deepEqual(
          yield* runtime.fillContactInfo({ ...identity, contactInfoId: contact.id }),
          {
            ok: true,
          },
        );
        assert.deepEqual(send.mock.calls[0], [
          "browser-contact-info-fill",
          {
            origin: "https://example.com",
            contactInfo: {
              addressLine1: "1 Private Street",
              addressLine2: "",
              city: "Shanghai",
              country: "China",
              email: "person@example.com",
              fullName: "Example Person",
              phone: "+86 123",
              postalCode: "200000",
              region: "Shanghai",
            },
          },
        ]);
      }),
    );

    it.effect(
      "rejects a candidate from another renderer owner and clears candidates on release",
      () =>
        Effect.gen(function* () {
          const { runtime } = yield* makeHarness;
          const candidate = yield* runtime.captureGuestCandidate(42, {
            username: "person",
            password: "top-secret",
          });
          assert.isFalse(
            (yield* runtime.actOnCandidate(8, {
              candidateId: candidate!.candidateId,
              action: "save",
            })).ok,
          );
          yield* runtime.releaseOwner(7);
          assert.isFalse(
            (yield* runtime.actOnCandidate(7, {
              candidateId: candidate!.candidateId,
              action: "save",
            })).ok,
          );
        }),
    );

    it.effect("does not prompt again when submitted credentials are unchanged", () =>
      Effect.gen(function* () {
        const { runtime, vault } = yield* makeHarness;
        vault.save({ origin: "https://example.com", username: "person", password: "top-secret" });
        assert.isNull(
          yield* runtime.captureGuestCandidate(42, {
            username: "person",
            password: "top-secret",
          }),
        );
      }),
    );
  });

  describe("browser-credential-vault", () => {
    const roots: string[] = [];

    afterEach(() => {
      for (const root of roots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    function createVault(available = true) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-vault-"));
      roots.push(root);
      return new BrowserCredentialVault({
        filePath: path.join(root, "secrets", "browser-credentials.v1.json"),
        encryption: {
          isAvailable: () => available,
          encryptString: (value) => Buffer.from(`encrypted:${value}`),
          decryptString: (value) => value.toString().slice("encrypted:".length),
        },
        now: () => new Date("2026-07-29T12:00:00.000Z"),
      });
    }

    describe("BrowserCredentialVault", () => {
      test("persists encrypted secrets while exposing summary-only listings", async () => {
        const vault = createVault();
        const summary = await vault.save({
          origin: "https://example.com/login?next=private",
          username: "person@example.com",
          password: "correct horse battery staple",
        });

        expect(await vault.listForOrigin("https://example.com/other")).toEqual([summary]);
        const raw = fs.readFileSync(
          path.join(roots[0]!, "secrets", "browser-credentials.v1.json"),
          "utf8",
        );
        expect(raw).not.toContain("correct horse battery staple");
        if (process.platform !== "win32") {
          expect(
            fs.statSync(path.join(roots[0]!, "secrets", "browser-credentials.v1.json")).mode &
              0o077,
          ).toBe(0);
        }
        expect((await vault.get(summary.id))?.password).toBe("correct horse battery staple");
      });

      test("uses origin and username as the idempotent credential key", async () => {
        const vault = createVault();
        const first = await vault.save({
          origin: "https://example.com",
          username: "person",
          password: "first-secret",
        });
        const second = await vault.save({
          origin: "https://example.com/settings",
          username: "person",
          password: "replacement-secret",
        });

        expect(second.id).toBe(first.id);
        expect(await vault.list()).toHaveLength(1);
        expect((await vault.get(first.id))?.password).toBe("replacement-secret");
        expect(
          await vault.matches({
            origin: "https://example.com",
            username: "person",
            password: "replacement-secret",
          }),
        ).toBe(true);
      });

      test("fails closed when secure storage is unavailable", async () => {
        const vault = createVault(false);
        expect(vault.capability()).toMatchObject({
          available: false,
          provider: "unavailable",
        });
        expect(() =>
          vault.save({
            origin: "https://example.com",
            username: "person",
            password: "secret",
          }),
        ).toThrow("unavailable");
      });

      test("generates passwords with every required character class", () => {
        const password = createVault().generate(32);
        expect(password).toHaveLength(32);
        expect(password).toMatch(/[a-z]/u);
        expect(password).toMatch(/[A-Z]/u);
        expect(password).toMatch(/[0-9]/u);
        expect(password).toMatch(/[!@#$%^&*()\-_=+]/u);
      });

      test("encrypts contact info and supports id-preserving edits", async () => {
        const vault = createVault();
        const first = await vault.saveContactInfo({
          label: "Home",
          fullName: "Example Person",
          email: "person@example.com",
          phone: "",
          addressLine1: "1 Private Street",
          addressLine2: "",
          city: "Shanghai",
          region: "",
          postalCode: "200000",
          country: "China",
        });
        const updated = await vault.saveContactInfo({
          id: first.id,
          label: "Primary",
          fullName: first.fullName,
          email: first.email,
          phone: first.phone,
          addressLine1: first.addressLine1,
          addressLine2: first.addressLine2,
          city: "Hangzhou",
          region: first.region,
          postalCode: first.postalCode,
          country: first.country,
        });

        expect(updated.id).toBe(first.id);
        expect(await vault.listContactInfo()).toEqual([updated]);
        const raw = fs.readFileSync(
          path.join(roots[0]!, "secrets", "browser-credentials.v1.json"),
          "utf8",
        );
        expect(raw).not.toContain("person@example.com");
        expect(raw).not.toContain("Private Street");
        await vault.removeContactInfo(updated.id);
        expect(await vault.listContactInfo()).toEqual([]);
      });
    });
  });
});

describe("browser-page-store", () => {
  const identity = {
    browserConversationId: "conversation-1",
    browserViewScopeId: "window-session-1",
    browserTabId: "browser-tab-1",
  } as const;

  const withPages = <A, E, R>(
    run: (input: { readonly filePath: string; readonly root: string }) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-pages-"));
        return { root, filePath: path.join(root, "browser-sidebar-page-states.json") };
      }),
      run,
      ({ root }) => Effect.sync(() => fs.rmSync(root, { recursive: true, force: true })),
    );

  const page = (
    browserStorageId: string,
    overrides: Partial<BrowserSerializedPage> = {},
  ): BrowserSerializedPage => ({
    schemaVersion: 1,
    runtime: "electron-webview",
    browserStorageId,
    identity,
    title: "Example",
    url: "https://example.com/",
    updatedAt: 1,
    navigation: {
      currentIndex: 0,
      entries: [
        {
          title: "Example",
          url: "https://example.com/",
          pageState: "state",
        },
      ],
    },
    ...overrides,
  });

  it.layer(NodeServices.layer)("Browser page runtime", (it) => {
    it.effect("persists and reloads a validated navigation snapshot", () =>
      withPages(({ filePath }) =>
        Effect.gen(function* () {
          const pages = yield* makeBrowserPageRuntime(filePath);
          yield* pages.set(page("browser:one"));

          const reloaded = yield* makeBrowserPageRuntime(filePath);
          assert.deepEqual(yield* reloaded.get("browser:one"), page("browser:one"));
          assert.deepInclude(JSON.parse(fs.readFileSync(filePath, "utf8")), {
            schemaVersion: 1,
          });
        }),
      ),
    );

    it.effect("round-trips file, credentialed and long data URLs without a navigation cap", () =>
      withPages(({ filePath }) =>
        Effect.gen(function* () {
          const pages = yield* makeBrowserPageRuntime(filePath);
          const url = `data:text/html,${"x".repeat(80_000)}`;
          const snapshot = page("browser:urls", {
            url,
            navigation: {
              currentIndex: 2,
              entries: [
                { title: "Local", url: "file:///tmp/index.html" },
                { title: "Web", url: "https://user:secret@example.com/" },
                { title: "Data", url },
              ],
            },
          });
          yield* pages.set(snapshot);
          const reloaded = yield* makeBrowserPageRuntime(filePath);
          assert.deepEqual(yield* reloaded.get("browser:urls"), snapshot);
        }),
      ),
    );

    it.effect("keeps at most 500 navigation entries and 100 pages", () =>
      withPages(({ filePath }) =>
        Effect.gen(function* () {
          const pages = yield* makeBrowserPageRuntime(filePath);
          yield* pages.set(
            page("browser:long", {
              navigation: {
                currentIndex: 549,
                entries: Array.from({ length: 550 }, (_, index) => ({
                  title: `Page ${index}`,
                  url: `https://example.com/${index}`,
                })),
              },
            }),
          );
          const long = yield* pages.get("browser:long");
          assert.lengthOf(long?.navigation.entries ?? [], 500);
          assert.strictEqual(long?.navigation.currentIndex, 499);

          for (let index = 0; index < 101; index += 1) {
            yield* pages.set(page(`browser:${index}`, { updatedAt: index + 1 }));
          }
          assert.isNull(yield* pages.get("browser:0"));
          assert.isNotNull(yield* pages.get("browser:100"));
        }),
      ),
    );

    it.effect("quarantines corruption without preventing startup", () =>
      withPages(({ filePath, root }) =>
        Effect.gen(function* () {
          fs.writeFileSync(filePath, "{not-json", "utf8");
          const pages = yield* makeBrowserPageRuntime(filePath);
          assert.isNull(yield* pages.get("browser:missing"));
          const quarantine = fs
            .readdirSync(root)
            .find((name) => name.startsWith("browser-sidebar-page-states.json.corrupt-"));
          assert.isString(quarantine);
          assert.strictEqual(fs.readFileSync(path.join(root, quarantine!), "utf8"), "{not-json");
        }),
      ),
    );

    it.effect("reassociates a page without retaining the source identity", () =>
      withPages(({ filePath }) =>
        Effect.gen(function* () {
          const pages = yield* makeBrowserPageRuntime(filePath);
          yield* pages.set(page("browser:source"));
          yield* pages.reassociate("browser:source", "browser:target");

          assert.isNull(yield* pages.get("browser:source"));
          assert.deepInclude(yield* pages.get("browser:target"), {
            browserStorageId: "browser:target",
          });
        }),
      ),
    );

    it.effect("clears durable navigation history without touching the Browser profile", () =>
      withPages(({ filePath }) =>
        Effect.gen(function* () {
          const pages = yield* makeBrowserPageRuntime(filePath);
          yield* pages.set(page("browser:one"));
          yield* pages.set(page("browser:two"));
          yield* pages.clear;
          assert.isNull(yield* pages.get("browser:one"));
          assert.isNull(yield* pages.get("browser:two"));
        }),
      ),
    );
  });
});

describe("browser-history-store", () => {
  const withHistory = <A, E, R>(
    run: (input: { readonly filePath: string; readonly root: string }) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-history-"));
        return { root, filePath: path.join(root, "browser-history.json") };
      }),
      run,
      ({ root }) => Effect.sync(() => fs.rmSync(root, { recursive: true, force: true })),
    );

  it.layer(NodeServices.layer)("Browser history runtime", (it) => {
    it.effect("persists searchable visit history and coalesces identical URLs", () =>
      withHistory(({ filePath }) =>
        Effect.gen(function* () {
          const history = yield* makeBrowserHistoryRuntime(filePath);
          yield* history.record({
            url: "https://example.com/path?q=one",
            title: "Example",
            visitedAt: 10,
          });
          yield* history.record({
            url: "https://example.com/path?q=one",
            title: "Updated title",
            visitedAt: 20,
          });
          yield* history.record({
            url: "https://other.example/",
            title: "Other",
            visitedAt: 15,
          });

          assert.deepInclude((yield* history.list()).entries[0], {
            title: "Updated title",
            visitCount: 2,
            lastVisitedAt: 20,
          });
          assert.lengthOf((yield* history.list({ query: "other" })).entries, 1);
          const reloaded = yield* makeBrowserHistoryRuntime(filePath);
          assert.lengthOf((yield* reloaded.list()).entries, 2);
        }),
      ),
    );

    it.effect("records admitted page URLs without a scheme or credential filter", () =>
      withHistory(({ filePath }) =>
        Effect.gen(function* () {
          const history = yield* makeBrowserHistoryRuntime(filePath);
          yield* history.record({ url: "javascript:alert(1)", title: "unsafe" });
          yield* history.record({
            url: "https://user:secret@example.com/",
            title: "credential",
          });
          yield* history.record({ url: "file:///tmp/index.html", title: "Local" });
          yield* history.record({ url: `data:text/html,${"x".repeat(20_000)}`, title: "Data" });
          assert.lengthOf((yield* history.list()).entries, 4);
        }),
      ),
    );

    it.effect("serializes concurrent mutations and reloads their durable result", () =>
      withHistory(({ filePath }) =>
        Effect.gen(function* () {
          const history = yield* makeBrowserHistoryRuntime(filePath);
          yield* Effect.all(
            [
              history.record({ url: "https://one.example/", title: "One", visitedAt: 1 }),
              history.record({ url: "https://two.example/", title: "Two", visitedAt: 2 }),
            ],
            { concurrency: "unbounded" },
          );
          const reloaded = yield* makeBrowserHistoryRuntime(filePath);
          assert.lengthOf((yield* reloaded.list()).entries, 2);

          const [entry] = (yield* history.list({ query: "one" })).entries;
          yield* history.delete(entry!.id);
          yield* history.clear;
          assert.isEmpty((yield* history.list()).entries);
        }),
      ),
    );

    it.effect("quarantines malformed history instead of trusting it", () =>
      withHistory(({ filePath, root }) =>
        Effect.gen(function* () {
          fs.writeFileSync(filePath, "{broken");
          const history = yield* makeBrowserHistoryRuntime(filePath);
          assert.isEmpty((yield* history.list()).entries);
          assert.isTrue(
            fs.readdirSync(root).some((name) => name.startsWith("browser-history.json.corrupt-")),
          );
        }),
      ),
    );
  });
});
