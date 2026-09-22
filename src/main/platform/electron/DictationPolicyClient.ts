import {
  StatsigClient,
  StatsigMetadataProvider,
  StatsigSession,
  StableID,
  NetworkCore,
  UrlConfiguration,
  Endpoint,
  LogLevel,
  _getFullUserHash,
  type StatsigOptions,
  type StatsigUser,
} from "@statsig/js-client";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ElectronNet, type readDesktopBootstrapMetadata } from "./ElectronNet";
import { makeDictationLiveValues } from "../../dictation/DictationLiveValues";
import type { DictationGateValues } from "../../dictation/DictationPolicyState";

const SDK_KEY = "client-sYWqzCYMRkUg4DqqiZcR5DGTNl2iD7zNJY0HoeDLzxR";
const API = "https://ab.chatgpt.com/v1";
const Primitive = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.mutable(Schema.Array(Schema.String)),
]);
export const PolicyUser = Schema.Struct({
  userID: Schema.optionalKey(Schema.String),
  customIDs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  email: Schema.optionalKey(Schema.String),
  ip: Schema.optionalKey(Schema.String),
  userAgent: Schema.optionalKey(Schema.String),
  country: Schema.optionalKey(Schema.String),
  locale: Schema.optionalKey(Schema.String),
  appVersion: Schema.optionalKey(Schema.String),
  custom: Schema.optionalKey(Schema.Record(Schema.String, Primitive)),
  privateAttributes: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Primitive))),
  analyticsOnlyMetadata: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])),
  ),
});
const CanonicalPayload = Schema.Struct({ user: PolicyUser });
const FallbackClaims = Schema.Struct({
  "https://api.openai.com/profile": Schema.optionalKey(
    Schema.Struct({ email: Schema.optionalKey(Schema.String) }),
  ),
  "https://api.openai.com/auth": Schema.Struct({
    chatgpt_compute_residency: Schema.optionalKey(Schema.String),
  }),
});
export const makePolicyFallbackUser = (input: {
  token?: string;
  identity: { accountId: string; userId: string } | null;
  authMethod?: string | null;
  plan: string | null;
  workspaceId?: string;
  metadata: Effect.Success<typeof readDesktopBootstrapMetadata>;
}): StatsigUser => {
  const claims = input.token
    ? Schema.decodeSync(Schema.fromJsonString(FallbackClaims))(
        Buffer.from(input.token.split(".")[1] ?? "", "base64url").toString("utf8"),
      )
    : undefined;
  const email = claims?.["https://api.openai.com/profile"]?.email;
  const metadata = input.metadata;
  const method = input.authMethod === undefined ? "chatgpt" : input.authMethod;
  const stableId = StableID.get(SDK_KEY);
  return {
    userID:
      input.identity?.userId ?? (method === "apikey" && stableId ? `ua-${stableId}` : undefined),
    email,
    locale: metadata.locale,
    appVersion: metadata.app_version,
    customIDs: {
      ...(stableId ? { stableID: stableId, source_surface_stable_id: stableId } : {}),
      ...(input.identity ? { account_id: input.identity.accountId } : {}),
      ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
    },
    custom: {
      auth_status:
        method === "chatgpt" || method === "personalAccessToken" ? "logged_in" : "logged_out",
      auth_method: method ?? undefined,
      account_id: input.identity?.accountId,
      plan_type: input.plan ?? undefined,
      compute_residency: claims?.["https://api.openai.com/auth"].chatgpt_compute_residency,
      ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
      is_openai_internal: email?.endsWith("@openai.com") ?? false,
      brand_name: metadata.brand_name,
      systemName: metadata.system_name,
      systemVersion: metadata.system_version ?? undefined,
      codex_window_type: metadata.window_type,
      codex_build_flavor: metadata.build_flavor,
      codex_app_session_id: metadata.app_session_id,
      desktop_app_beta_enabled: false,
    },
  };
};
export const decodePolicyBootstrap = (
  response: unknown,
  expected: { accountId: string; userId: string },
) => {
  const { statsigPayload } = Schema.decodeUnknownSync(
    Schema.Struct({ statsigPayload: Schema.String }),
  )(response);
  const { user } = Schema.decodeSync(Schema.fromJsonString(CanonicalPayload), {
    onExcessProperty: "preserve",
  })(statsigPayload);
  if (user.userID !== expected.userId || user.customIDs?.account_id !== expected.accountId)
    throw new Error("Authenticated policy identity changed");
  return { statsigPayload, user };
};

export class DictationPolicyClientError extends Schema.TaggedError<DictationPolicyClientError>()(
  "DictationPolicyClientError",
  { message: Schema.String },
) {}

/** Scoped vendor adapter. Gate evaluation remains available independently of analytics consent. */
export const makeDictationPolicyClient = Effect.fn("DictationPolicyClient.make")(function* (input: {
  readonly user: StatsigUser;
  readonly bootstrap?: string;
  readonly signal: AbortSignal;
  readonly metadata: Effect.Success<typeof readDesktopBootstrapMetadata>;
}) {
  const electron = yield* ElectronNet;
  const runPromise = yield* FiberSet.makeRuntimePromise();
  const lifetime = yield* Effect.abortSignal;
  const signal = AbortSignal.any([input.signal, lifetime]);
  const fetch = (url: string, args: RequestInit, onResponse?: (response: Response) => void) =>
    runPromise(
      Effect.gen(function* () {
        if (signal.aborted)
          return yield* new DictationPolicyClientError({ message: "Policy lifetime ended" });
        const parsed = new URL(url);
        if (parsed.origin !== "https://ab.chatgpt.com" || parsed.pathname !== "/v1/initialize")
          return new Response(null, { status: 204 });
        const headers = new Headers(args.headers);
        headers.set("Content-Type", "application/json");
        const response = yield* electron.fetch(url, {
          ...args,
          headers,
          redirect: "error",
          signal,
        });
        onResponse?.(response);
        return response;
      }),
    ).catch((error: unknown) => {
      // Prevent the vendor retry loop from outliving a revoked account or closed Scope.
      if (signal.aborted) return new Response(null, { status: 499 });
      throw error;
    });
  const options: StatsigOptions = {
    disableStorage: true,
    loggingEnabled: "disabled",
    logLevel: LogLevel.None,
    networkConfig: {
      api: API,
      sdkExceptionUrl: `${API}/sdk_exception`,
      preventAllNetworkTraffic: false,
      networkOverrideFunc: fetch,
    },
  };
  StatsigSession.overrideInitialSessionID(input.metadata.app_session_id, SDK_KEY);
  StatsigMetadataProvider.add({
    appIdentifier: "codex-electron",
    appVersion: input.metadata.app_version,
    locale: input.metadata.locale,
    systemName: input.metadata.system_name,
    systemVersion: input.metadata.system_version ?? undefined,
  });
  const client = new StatsigClient(SDK_KEY, input.user, options);
  yield* Effect.addFinalizer(() => Effect.promise(() => client.shutdown()));
  if (input.bootstrap !== undefined) {
    client.dataAdapter.setData(input.bootstrap);
    client.initializeSync();
  } else {
    yield* Effect.tryPromise({
      try: () => client.initializeAsync(),
      catch: () => new DictationPolicyClientError({ message: "Policy initialization failed" }),
    });
  }
  if (signal.aborted)
    return yield* new DictationPolicyClientError({ message: "Policy lifetime ended" });
  const context = client.getContext();
  const cached = client.dataAdapter.getDataSync(context.user);
  const overlay = makeDictationLiveValues(
    context.values,
    cached?.fullUserHash != null && cached.fullUserHash === _getFullUserHash(context.user),
  );
  const evaluate = (): DictationGateValues => {
    const gate = (name: string) =>
      overlay.gate(name, client.getFeatureGate(name, { disableExposureLog: true }).value);
    const dictionary = overlay.config(
      "3845962714",
      client.getDynamicConfig("3845962714", { disableExposureLog: true }).value,
    );
    const parsed = Schema.decodeUnknownOption(
      Schema.Struct({ dictation_custom_dictionary_enabled: Schema.optionalKey(Schema.Boolean) }),
    )(dictionary);
    return {
      composer: gate("4100906017"),
      global: gate("1244621283"),
      workspacePermissions: gate("770071981"),
      streaming: gate("codex-app-dictation-streaming"),
      sounds: gate("codex-app-dictation-sounds"),
      voiceDictionary:
        parsed._tag === "Some" && parsed.value.dictation_custom_dictionary_enabled === true,
    };
  };
  const values = yield* SubscriptionRef.make(evaluate());
  let liveHeader: string | null = null;
  const network = new NetworkCore({
    ...options,
    networkConfig: {
      ...options.networkConfig,
      networkOverrideFunc: (url, args) =>
        fetch(url, args, (response) => {
          liveHeader = response.headers.get("x-statsig-live-overlay-lcut");
        }),
    },
  });
  const refreshLive = Effect.gen(function* () {
    if (signal.aborted) return;
    liveHeader = null;
    const response = yield* Effect.tryPromise({
      try: () =>
        network.post({
          sdkKey: SDK_KEY,
          urlConfig: new UrlConfiguration(Endpoint._initialize, undefined, API, undefined),
          data: {
            responseMode: "live_overlay",
            user: context.user,
            hash: "djb2",
            ...overlay.requestCursor(),
          },
          retries: 2,
          isStatsigEncodable: true,
          priority: "low",
        }),
      catch: () => new DictationPolicyClientError({ message: "Policy refresh failed" }),
    });
    if (signal.aborted || response === null) return;
    if (response.code === 204) {
      overlay.advance(liveHeader);
      return;
    }
    if (response.code !== 200 || response.body === null) return;
    const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
      response.body,
    );
    const changed = yield* Effect.try({
      try: () => overlay.apply(payload),
      catch: () => new DictationPolicyClientError({ message: "Invalid live policy" }),
    });
    if (changed) yield* SubscriptionRef.set(values, evaluate());
  }).pipe(Effect.ignore);
  // The SDK's live overlay does not replace non-live session evaluations.
  yield* Effect.gen(function* () {
    const now = Effect.clockWith((clock) => clock.currentTimeMillis);
    let next = (yield* now) + overlay.intervalMs;
    while (!signal.aborted) {
      yield* Effect.sleep(Math.max(0, next - (yield* now)));
      yield* refreshLive;
      // Keep the interval cadence while skipping ticks occupied by a previous request.
      next +=
        (Math.floor(Math.max(0, (yield* now) - next) / overlay.intervalMs) + 1) *
        overlay.intervalMs;
    }
  }).pipe(Effect.forkScoped);
  return { read: SubscriptionRef.get(values), changes: SubscriptionRef.changes(values) };
});
