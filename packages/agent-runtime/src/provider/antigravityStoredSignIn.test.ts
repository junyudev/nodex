import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  ANTIGRAVITY_SIGN_IN_FILE,
  parseAntigravityStoredSignIn,
  readAntigravityStoredSignIn,
} from "./antigravityStoredSignIn.ts";

const stored = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    token: { access_token: "access", refresh_token: "refresh", expiry: "2999-01-01T00:00:00Z" },
    auth_method: "oauth-personal",
    id_token_email: "person@example.com",
    ...fields,
  });

describe("parseAntigravityStoredSignIn", () => {
  it("reads agy's keyring encodings and its plain file", () => {
    const signedIn = {
      status: "signed-in",
      accessToken: "access",
      refreshToken: "refresh",
      expiry: "2999-01-01T00:00:00Z",
      authMethod: "oauth-personal",
      email: "person@example.com",
    };
    expect(
      parseAntigravityStoredSignIn(
        `go-keyring-base64:${Buffer.from(stored()).toString("base64")}\n`,
      ),
    ).toEqual(signedIn);
    expect(
      parseAntigravityStoredSignIn(`go-keyring-encoded:${Buffer.from(stored()).toString("hex")}`),
    ).toEqual(signedIn);
    expect(parseAntigravityStoredSignIn(stored())).toEqual(signedIn);
  });

  it("keeps the Enterprise method and treats an unusable value as no sign-in", () => {
    expect(parseAntigravityStoredSignIn(stored({ auth_method: "oauth-business" }))).toMatchObject({
      authMethod: "oauth-business",
    });
    expect(parseAntigravityStoredSignIn(stored({ token: { access_token: "" } }))).toEqual({
      status: "signed-out",
    });
    expect(parseAntigravityStoredSignIn("go-keyring-base64:not json")).toEqual({
      status: "signed-out",
    });
  });
});

/** Answers keyring reads with a shell result, so a test never reads this computer's keyring. */
const keyringAnswering = (
  script: string | "missing",
  reads: string[],
  environments: Array<Record<string, string | undefined> | undefined> = [],
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) => {
      if (command._tag === "StandardCommand") {
        reads.push(command.command);
        environments.push(command.options.env);
      }
      return script === "missing"
        ? spawner.spawn(ChildProcess.make("/nonexistent/secret-tool", []))
        : spawner.spawn(ChildProcess.make("/bin/sh", ["-c", script]));
    });
  });

describe("readAntigravityStoredSignIn", () => {
  it.effect.skipIf(process.platform === "win32")(
    "prefers the profile's file and reads this computer's keyring only for a shared profile",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profileDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-agy-signin-" });
        const reads: string[] = [];
        const environments: Array<Record<string, string | undefined> | undefined> = [];
        const environment = {
          HOME: "/agy/home",
          PATH: "/usr/bin",
          DBUS_SESSION_BUS_ADDRESS: "bus",
        };
        const read = (input: { shared: boolean; platform: NodeJS.Platform }, script: string) =>
          keyringAnswering(script, reads, environments).pipe(
            Effect.flatMap((spawner) =>
              readAntigravityStoredSignIn({ profileDirectory, environment, ...input }).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              ),
            ),
          );

        // A private profile is signed out without its file, whatever the keyring holds.
        const keyring = `printf '%s' 'go-keyring-base64:${Buffer.from(stored()).toString("base64")}'`;
        expect(yield* read({ shared: false, platform: "darwin" }, keyring)).toEqual({
          status: "signed-out",
        });
        expect(reads).toEqual([]);

        expect(yield* read({ shared: true, platform: "darwin" }, keyring)).toMatchObject({
          status: "signed-in",
          email: "person@example.com",
        });
        expect(reads).toEqual(["/usr/bin/security"]);
        expect(yield* read({ shared: true, platform: "darwin" }, "exit 44")).toEqual({
          status: "signed-out",
        });
        expect(yield* read({ shared: true, platform: "linux" }, "exit 1")).toEqual({
          status: "signed-out",
        });
        // Each keyring is read where agy reads it: security searches its HOME's keychains, and
        // secret-tool asks the session bus agy's environment names. A Nodex running agy in another
        // home, such as a development Profile, must not read the account's sign-in agy can't use.
        expect(environments).toEqual([{ HOME: "/agy/home" }, { HOME: "/agy/home" }, environment]);
        expect(yield* read({ shared: true, platform: "darwin" }, "exit 36")).toEqual({
          status: "unknown",
        });
        expect(yield* read({ shared: true, platform: "linux" }, "missing")).toEqual({
          status: "unknown",
        });
        expect(yield* read({ shared: true, platform: "win32" }, keyring)).toEqual({
          status: "unknown",
        });

        // Without a keyring, agy keeps the sign-in in a file below its app data.
        const file = path.join(profileDirectory, "antigravity-acp", ANTIGRAVITY_SIGN_IN_FILE);
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, stored({ id_token_email: "file@example.com" }));
        reads.length = 0;
        for (const shared of [false, true]) {
          expect(yield* read({ shared, platform: "darwin" }, "exit 44")).toMatchObject({
            status: "signed-in",
            email: "file@example.com",
          });
        }
        expect(reads).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
