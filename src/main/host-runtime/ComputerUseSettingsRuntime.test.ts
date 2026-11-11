import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import {
  ComputerUseSettingsError,
  ComputerUseSettingsRuntime,
  testLayer,
} from "./ComputerUseSettingsRuntime";

const availableRuntime = {
  appPath: "/canonical/Codex Computer Use.app",
  hostServicesPipePath: "/tmp/host.sock",
  serviceExecutablePath: "/canonical/service",
  status: "available" as const,
};

const approvalsDirectory = (homeDirectory: string) =>
  path.join(
    homeDirectory,
    "Library",
    "Group Containers",
    "2DC432GLL2.com.openai.sky.CUAService",
    "Library",
    "Application Support",
    "Software",
  );

const withRuntime = <A, E>(
  buildPorts: (homeDirectory: string) => Parameters<typeof testLayer>[0],
  use: (
    runtime: ComputerUseSettingsRuntime["Service"],
    homeDirectory: string,
  ) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "nodex-computer-use-settings-effect-"))),
    (homeDirectory) =>
      Effect.scoped(
        Layer.build(testLayer(buildPorts(homeDirectory))).pipe(
          Effect.flatMap((context) =>
            use(Context.get(context, ComputerUseSettingsRuntime), homeDirectory),
          ),
        ),
      ),
    (homeDirectory) => Effect.sync(() => rmSync(homeDirectory, { force: true, recursive: true })),
  );

it.effect("projects approvals, native settings, runtime availability, and PiP preference", () =>
  withRuntime(
    (homeDirectory) => {
      const directory = approvalsDirectory(homeDirectory);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "ComputerUseAppApprovals.json"),
        JSON.stringify({
          approvedBundleIdentifiers: ["com.apple.Safari", "com.apple.Safari", ""],
        }),
      );
      writeFileSync(
        path.join(directory, "MessagesSendApprovals.json"),
        JSON.stringify({ approvedChats: { guid2: "Work", guid1: "Alice" } }),
      );
      return {
        exec: (executablePath, args) =>
          Effect.sync(() =>
            executablePath === "/usr/bin/defaults"
              ? { stdout: "foregroundAndBackgroundClicks\n", stderr: "" }
              : { stdout: args[0] === "status" ? "OK: installed\n" : "", stderr: "" },
          ),
        getAlwaysHide: () => true,
        getRuntimeResult: Effect.succeed(availableRuntime),
        homeDirectory,
        platform: "darwin",
        readLockedUseAllowed: Effect.succeed(true),
        setAlwaysHide: () => Effect.void,
      };
    },
    (runtime) =>
      runtime.getSnapshot.pipe(
        Effect.tap((snapshot) =>
          Effect.sync(() => {
            assert.deepEqual(snapshot, {
              alwaysHidePictureInPicture: true,
              approvedApps: [
                {
                  bundleIdentifier: "com.apple.Safari",
                  displayName: "com.apple.Safari",
                },
              ],
              approvedMessageThreads: [
                { chatGuid: "guid1", displayName: "Alice" },
                { chatGuid: "guid2", displayName: "Work" },
              ],
              available: true,
              lockedUseAllowed: true,
              lockedUseEnabled: true,
              message: null,
              soundMode: "foregroundAndBackgroundClicks",
            });
          }),
        ),
        Effect.asVoid,
      ),
  ),
);

it.effect("serializes concurrent mutations and routes native settings commands", () => {
  const commands: Array<{ path: string; args: readonly string[] }> = [];
  let alwaysHide = false;
  return withRuntime(
    (homeDirectory) => {
      const directory = approvalsDirectory(homeDirectory);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "ComputerUseAppApprovals.json"),
        JSON.stringify({ approvedBundleIdentifiers: ["one", "two", "three"] }),
      );
      return {
        exec: (executablePath, args) =>
          Effect.sync(() => {
            commands.push({ path: executablePath, args });
            return { stdout: "OK: installed\n", stderr: "" };
          }),
        getAlwaysHide: () => alwaysHide,
        getRuntimeResult: Effect.succeed(availableRuntime),
        homeDirectory,
        platform: "darwin",
        readLockedUseAllowed: Effect.succeed(true),
        setAlwaysHide: (value) =>
          Effect.sync(() => {
            alwaysHide = value;
          }),
      };
    },
    (runtime, homeDirectory) =>
      Effect.gen(function* () {
        yield* Effect.all([runtime.removeAppApproval("one"), runtime.removeAppApproval("two")], {
          concurrency: "unbounded",
        });
        yield* runtime.setAlwaysHidePictureInPicture(true);
        yield* runtime.setSoundMode("off");
        yield* runtime.setLockedUseEnabled(false);

        assert.deepEqual(
          JSON.parse(
            readFileSync(
              path.join(approvalsDirectory(homeDirectory), "ComputerUseAppApprovals.json"),
              "utf8",
            ),
          ),
          { approvedBundleIdentifiers: ["three"] },
        );
        assert.isTrue(alwaysHide);
        assert.isTrue(
          commands.some(
            (command) =>
              command.path === "/usr/bin/defaults" && command.args.join("\0").endsWith("\0off"),
          ),
        );
        assert.isTrue(
          commands.some(
            (command) =>
              command.path.endsWith("Codex Computer Use Installer") &&
              command.args[0] === "uninstall",
          ),
        );
      }),
  );
});

it.effect("fails closed when Locked Use is not allowed", () =>
  withRuntime(
    (homeDirectory) => ({
      exec: () => Effect.succeed({ stdout: "", stderr: "" }),
      getAlwaysHide: () => false,
      getRuntimeResult: Effect.succeed(availableRuntime),
      homeDirectory,
      platform: "darwin",
      readLockedUseAllowed: Effect.succeed(false),
      setAlwaysHide: () => Effect.void,
    }),
    (runtime) =>
      runtime.setLockedUseEnabled(true).pipe(
        Effect.flip,
        Effect.orDie,
        Effect.tap((error) =>
          Effect.sync(() => {
            assert.instanceOf(error, ComputerUseSettingsError);
            assert.match(String(error.cause), /disabled by configuration requirements/);
          }),
        ),
        Effect.asVoid,
      ),
  ),
);

it.effect("projects Windows availability and revokes only the selected app", () => {
  let enabled = true;
  let approved = ["aumid:Editor", "exe:Calculator"];
  return withRuntime(
    (homeDirectory) => ({
      platform: "win32",
      homeDirectory,
      exec: () => Effect.die("Windows settings must not invoke native macOS commands"),
      getAlwaysHide: () => {
        throw new Error("Native PiP preference read on Windows");
      },
      readLockedUseAllowed: Effect.die("Locked Use read on Windows"),
      setAlwaysHide: () => Effect.die("Native PiP preference written on Windows"),
      getRuntimeResult: Effect.sync(() =>
        enabled
          ? {
              platform: "win32",
              nativePipePath: "fixture-pipe",
              serviceExecutablePath: "fixture.exe",
              status: "available",
            }
          : { status: "unavailable", reason: "disabled", message: "Computer Use is turned off." },
      ),
      windows: {
        enabled: () => enabled,
        setEnabled: (next) =>
          Effect.sync(() => {
            enabled = next;
          }),
        readApprovedApps: Effect.sync(() => approved),
        revoke: (id) =>
          Effect.sync(() => {
            approved = approved.filter((app) => app !== id);
          }),
      },
    }),
    (runtime) =>
      Effect.gen(function* () {
        const initial = yield* runtime.getSnapshot;
        assert.deepEqual(initial.windows, { enabled: true });
        assert.isTrue(initial.available);
        assert.deepEqual(
          initial.approvedApps.map((app) => app.displayName),
          approved,
        );
        assert.notProperty(initial, "approvedMessageThreads");
        assert.notProperty(initial, "lockedUseEnabled");
        const removed = yield* runtime.removeAppApproval("aumid:Editor");
        assert.deepEqual(
          removed.approvedApps.map((app) => app.bundleIdentifier),
          ["exe:Calculator"],
        );
        const disabled = yield* runtime.setWindowsEnabled!(false);
        assert.deepEqual(disabled.windows, { enabled: false });
        assert.isFalse(disabled.available);
        assert.deepEqual(disabled.approvedApps, removed.approvedApps);
        yield* runtime.setSoundMode("off").pipe(Effect.flip);
        yield* runtime.removeMessageApproval("irrelevant").pipe(Effect.flip);
      }),
  );
});
