import { collectUint8StreamText } from "@nodex/provider-core/server/collectStreamText";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** The file agy 1.5 keeps a Google sign-in in when it bypasses the OS keyring, below its app data. */
export const ANTIGRAVITY_SIGN_IN_FILE = "antigravity-oauth-token";

// agy stores its Google sign-in through go-keyring under one service and account for every
// Gemini folder. On macOS go-keyring writes through /usr/bin/security, which therefore reads it
// back without a Keychain prompt; on Linux it uses the Secret Service attributes below.
const KEYRING_SERVICE = "gemini";
const KEYRING_ACCOUNT = "antigravity";
const MAC_ITEM_NOT_FOUND = 44;
const MAX_SECRET_BYTES = 64 * 1024;

/** The sign-in agy stores, in its keyring entry or file. It holds no OAuth client to refresh with. */
export const AntigravityStoredToken = Schema.Struct({
  token: Schema.Struct({
    access_token: Schema.NonEmptyString,
    refresh_token: Schema.optional(Schema.String),
    expiry: Schema.optional(Schema.String),
  }),
  auth_method: Schema.optional(Schema.String),
  id_token_email: Schema.optional(Schema.String),
});
const decodeStoredToken = Schema.decodeUnknownOption(Schema.fromJsonString(AntigravityStoredToken));

export type AntigravityStoredSignIn =
  | {
      readonly status: "signed-in";
      readonly accessToken: string;
      readonly refreshToken: string | undefined;
      readonly expiry: string | undefined;
      /** The Google method agy signed in with, which selects the quota host and `authenticate`. */
      readonly authMethod: "oauth-personal" | "oauth-business";
      readonly email: string | undefined;
    }
  | { readonly status: "signed-out" }
  /** This computer's keyring can't be read here, so only starting agy can tell. */
  | { readonly status: "unknown" };

const SIGNED_OUT: AntigravityStoredSignIn = { status: "signed-out" };
const UNKNOWN: AntigravityStoredSignIn = { status: "unknown" };

/** go-keyring encodes every value it writes; older entries may be stored as written. */
function decodeKeyringValue(value: string): string | undefined {
  const text = value.trim();
  try {
    if (text.startsWith("go-keyring-base64:"))
      return Buffer.from(text.slice("go-keyring-base64:".length), "base64").toString("utf8");
    if (text.startsWith("go-keyring-encoded:"))
      return Buffer.from(text.slice("go-keyring-encoded:".length), "hex").toString("utf8");
  } catch {
    return undefined;
  }
  return text;
}

/** A stored value as a sign-in; a value agy can't use is no sign-in at all. */
export function parseAntigravityStoredSignIn(value: string): AntigravityStoredSignIn {
  const decoded = decodeKeyringValue(value);
  const stored = decoded === undefined ? Option.none() : decodeStoredToken(decoded);
  if (Option.isNone(stored)) return SIGNED_OUT;
  const { token, auth_method: method, id_token_email: email } = stored.value;
  return {
    status: "signed-in",
    accessToken: token.access_token,
    refreshToken: token.refresh_token || undefined,
    expiry: token.expiry,
    authMethod: method === "oauth-business" ? "oauth-business" : "oauth-personal",
    email: email?.trim() || undefined,
  };
}

const readKeyring = Effect.fn("readAntigravityKeyring")(function* (platform: NodeJS.Platform) {
  const command =
    platform === "darwin"
      ? ChildProcess.make(
          "/usr/bin/security",
          ["find-generic-password", "-s", KEYRING_SERVICE, "-a", KEYRING_ACCOUNT, "-w"],
          { env: {}, extendEnv: false, shell: false },
        )
      : platform === "linux"
        ? ChildProcess.make(
            "secret-tool",
            ["lookup", "service", KEYRING_SERVICE, "username", KEYRING_ACCOUNT],
            { extendEnv: true, shell: false },
          )
        : undefined;
  if (command === undefined) return UNKNOWN;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(command);
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_SECRET_BYTES }),
        child.exitCode,
        Effect.ignore(collectUint8StreamText({ stream: child.stderr, maxBytes: 4_096 })),
      ],
      { concurrency: "unbounded" },
    );
    if (stdout.truncated) return SIGNED_OUT;
    if (Number(exitCode) === 0) return parseAntigravityStoredSignIn(stdout.text);
    // secret-tool exits 1 with nothing printed when the entry is absent.
    return (platform === "darwin" && Number(exitCode) === MAC_ITEM_NOT_FOUND) ||
      (platform === "linux" && Number(exitCode) === 1 && stdout.bytes === 0)
      ? SIGNED_OUT
      : UNKNOWN;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(UNKNOWN) }),
    Effect.orElseSucceed(() => UNKNOWN),
  );
});

/**
 * The Google sign-in an instance's agy would use. A private profile keeps it in its own file. This
 * computer's sign-in is the file agy writes where there is no keyring, otherwise the keyring entry
 * agy shares with its terminal. Reading never signs in, refreshes or prompts.
 */
export const readAntigravityStoredSignIn = Effect.fn("readAntigravityStoredSignIn")(
  function* (input: {
    readonly profileDirectory: string;
    readonly shared: boolean;
    readonly platform: NodeJS.Platform;
  }): Effect.fn.Return<
    AntigravityStoredSignIn,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(input.profileDirectory, "antigravity-acp", ANTIGRAVITY_SIGN_IN_FILE);
    const stored = yield* fs
      .readFileString(file)
      .pipe(Effect.orElseSucceed((): string | undefined => undefined));
    if (stored !== undefined) {
      const signIn = parseAntigravityStoredSignIn(stored);
      if (signIn.status === "signed-in" || !input.shared) return signIn;
    }
    return input.shared ? yield* readKeyring(input.platform) : SIGNED_OUT;
  },
);
