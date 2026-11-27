import {
  GitHubApi,
  PinnedGitHubCredential,
  SourceAccount,
} from "@nodex/agent-runtime/github-source";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { z } from "zod";

const accountSchema = z.object({ login: z.string().min(1), id: z.number().int().positive() });
const interactiveVerification = Context.Reference<boolean>("nodex/GitHubAccount/interactive", {
  defaultValue: () => false,
});

export class GitHubAccountVerificationError extends Schema.TaggedError<GitHubAccountVerificationError>()(
  "GitHubAccountVerificationError",
  { reason: Schema.Literals(["credential", "account_changed"]) },
) {
  override get message(): string {
    return this.reason === "account_changed"
      ? "The GitHub credential belongs to a different account."
      : "GitHub could not verify the connected account.";
  }
}

export const makeGitHubAccount = Effect.fn("GitHubAccount.make")(function* (
  api: GitHubApi["Service"],
) {
  const accounts = yield* Cache.makeWith(
    Effect.fn("GitHubAccount.verifyToken")(function* ([host]: readonly [string, string]) {
      const interactive = yield* interactiveVerification;
      const response = yield* api.rest({
        host,
        operation: "source.verify",
        path: "user",
        maxResponseBytes: 128 * 1024,
        ...(interactive ? { allowReserve: true, allowPaused: false } : {}),
      });
      return yield* Effect.try({
        try: () => {
          const account = accountSchema.parse(JSON.parse(response.body));
          return { login: account.login, id: String(account.id) };
        },
        catch: () => new GitHubAccountVerificationError({ reason: "credential" }),
      });
    }),
    {
      capacity: 64,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0),
    },
  );

  const verify = Effect.fn("GitHubAccount.verify")(function* (
    host: string,
    account?: string,
    id?: string,
    interactive = false,
  ) {
    const credential = yield* api
      .credential(host)
      .pipe(Effect.provideService(SourceAccount, account));
    const fingerprint = credential.fingerprint;
    const pin = { host, token: credential.token, credentialFingerprint: fingerprint };
    const use = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(PinnedGitHubCredential, pin));
    const identity = yield* use(Cache.get(accounts, [host, fingerprint])).pipe(
      Effect.provideService(interactiveVerification, interactive),
      Effect.mapError((error) =>
        error._tag === "GitHubApiNotFoundError" ||
        (error._tag === "GitHubApiResponseError" && error.status === 403)
          ? new GitHubAccountVerificationError({ reason: "credential" })
          : error,
      ),
    );
    if (
      (account && identity.login.toLowerCase() !== account.toLowerCase()) ||
      (id && identity.id !== id)
    )
      return yield* new GitHubAccountVerificationError({ reason: "account_changed" });
    return { ...identity, fingerprint, use };
  });
  return { verify };
});

export class GitHubAccount extends Context.Service<
  GitHubAccount,
  Effect.Success<ReturnType<typeof makeGitHubAccount>>
>()("nodex/host/GitHubAccount") {}

export const live = Layer.effect(GitHubAccount, Effect.flatMap(GitHubApi, makeGitHubAccount));
