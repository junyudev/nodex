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
import * as Random from "effect/Random";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ElectronNet, type readDesktopBootstrapMetadata } from "./ElectronNet";
import { makeDictationLiveValues } from "../../dictation/DictationLiveValues";
import type { DictationGateValues } from "../../dictation/DictationPolicyState";
import type { RealtimeVoiceGateValues } from "../../dictation/RealtimeVoicePolicyState";
import { isDeepStrictEqual } from "node:util";

const SDK_KEY = "client-sYWqzCYMRkUg4DqqiZcR5DGTNl2iD7zNJY0HoeDLzxR";
const API = "https://ab.chatgpt.com/v1";
const REQUEST_TIMEOUT_MS = 5_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 300_000;
const BaselinePayload = Schema.Struct({ has_updates: Schema.Literal(true) });
const Primitive = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.mutable(Schema.Array(Schema.String)),
]);
export const PolicyUser = Schema.StructWithRest(
  Schema.Struct({
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
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
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
  const { user } = Schema.decodeSync(Schema.fromJsonString(CanonicalPayload))(statsigPayload);
  if (user.userID !== expected.userId || user.customIDs?.account_id !== expected.accountId)
    throw new Error("Authenticated policy identity changed");
  return { statsigPayload, user };
};

export class DictationPolicyClientError extends Schema.TaggedError<DictationPolicyClientError>()(
  "DictationPolicyClientError",
  {
    reason: Schema.Literals(["network", "timeout", "http", "invalid-response", "aborted"]),
    status: Schema.optionalKey(Schema.Finite),
  },
) {}

/** Scoped vendor adapter. Gate evaluation remains available independently of analytics consent. */
export const makeDictationPolicyClient = Effect.fn("DictationPolicyClient.make")(function* (input: {
  readonly user: StatsigUser;
  readonly bootstrap?: string;
  readonly signal: AbortSignal;
  readonly metadata: Effect.Success<typeof readDesktopBootstrapMetadata>;
}) {
  const electron = yield* ElectronNet;
  const lifetime = yield* Effect.abortSignal;
  const signal = AbortSignal.any([input.signal, lifetime]);
  if (signal.aborted) return yield* new DictationPolicyClientError({ reason: "aborted" });
  const revoked = Effect.callback<void>((resume) => {
    const abort = () => resume(Effect.void);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
  const options: StatsigOptions = {
    disableStorage: true,
    loggingEnabled: "disabled",
    logLevel: LogLevel.None,
    networkConfig: {
      api: API,
      sdkExceptionUrl: `${API}/sdk_exception`,
      // The SDK evaluates supplied values; this Scope owns every network attempt.
      preventAllNetworkTraffic: true,
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
  client.initializeSync({ disableBackgroundCacheRefresh: true });
  let initialized = false;
  let overlay = makeDictationLiveValues(undefined);
  const evaluate = (live = overlay): DictationGateValues => {
    const gate = (name: string) =>
      live.gate(name, client.getFeatureGate(name, { disableExposureLog: true })?.value ?? false);
    const dictionary = live.config(
      "3845962714",
      client.getDynamicConfig("3845962714", { disableExposureLog: true })?.value,
    );
    const parsed = Schema.decodeUnknownOption(
      Schema.Struct({ dictation_custom_dictionary_enabled: Schema.optionalKey(Schema.Boolean) }),
    )(dictionary);
    return {
      composer: gate("4100906017"),
      workspacePermissions: gate("770071981"),
      voiceDictionary:
        parsed._tag === "Some" && parsed.value.dictation_custom_dictionary_enabled === true,
    };
  };
  const evaluateRealtime = (): RealtimeVoiceGateValues => {
    const config = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(
      overlay.config(
        "1193530394",
        client.getDynamicConfig("1193530394", { disableExposureLog: true }).value,
      ),
    );
    const sessionConfig = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(
      overlay.config(
        "3566525122",
        client.getDynamicConfig("3566525122", { disableExposureLog: true }).value,
      ),
    );
    return {
      entryPoint: overlay.gate(
        "2380644311",
        client.getFeatureGate("2380644311", { disableExposureLog: true }).value,
      ),
      blocked: overlay.gate(
        "1697652030",
        client.getFeatureGate("1697652030", { disableExposureLog: true }).value,
      ),
      clientOwnedCall: overlay.gate(
        "206132468",
        client.getFeatureGate("206132468", { disableExposureLog: true }).value,
      ),
      config: config._tag === "Some" ? config.value : {},
      sessionConfig: sessionConfig._tag === "Some" ? sessionConfig.value : {},
    };
  };
  const setBaseline = Effect.fn("DictationPolicyClient.setBaseline")(function* (
    body: string,
    canonical = false,
  ) {
    yield* Schema.decodeEffect(Schema.fromJsonString(BaselinePayload))(body).pipe(
      Effect.mapError(() => new DictationPolicyClientError({ reason: "invalid-response" })),
    );
    return yield* Effect.try({
      try: () => {
        if (canonical) client.dataAdapter.setData(body);
        else client.dataAdapter.setDataLegacy(body, input.user);
        client.updateUserSync(input.user, { disableBackgroundCacheRefresh: true });
        const context = client.getContext();
        const cached = client.dataAdapter.getDataSync(context.user);
        const next = makeDictationLiveValues(
          context.values,
          cached?.fullUserHash != null && cached.fullUserHash === _getFullUserHash(context.user),
        );
        const gates = evaluate(next);
        overlay = next;
        initialized = true;
        return gates;
      },
      catch: () => new DictationPolicyClientError({ reason: "invalid-response" }),
    });
  });
  if (input.bootstrap !== undefined)
    yield* setBaseline(input.bootstrap, true).pipe(Effect.catch(() => Effect.void));
  const values = yield* SubscriptionRef.make(evaluate());
  const realtimeValues = yield* SubscriptionRef.make(evaluateRealtime());
  // Realtime voice subscribers only hear about evaluations that actually changed.
  const publishRealtime = Effect.gen(function* () {
    const realtime = evaluateRealtime();
    if (!isDeepStrictEqual(yield* SubscriptionRef.get(realtimeValues), realtime))
      yield* SubscriptionRef.set(realtimeValues, realtime);
  });
  const fetch = Effect.fn("DictationPolicyClient.fetch")(function* (
    url: string,
    args: RequestInit,
    attemptSignal: AbortSignal,
  ) {
    if (attemptSignal.aborted) return yield* new DictationPolicyClientError({ reason: "aborted" });
    const parsed = new URL(url);
    if (parsed.origin !== "https://ab.chatgpt.com" || parsed.pathname !== "/v1/initialize")
      return new Response(null, { status: 204 });
    const headers = new Headers(args.headers);
    headers.set("Content-Type", "application/json");
    return yield* electron.fetch(url, {
      ...args,
      headers,
      redirect: "error",
      signal: attemptSignal,
    });
  });
  const request = Effect.fn("DictationPolicyClient.request")(
    function* (data: Record<string, unknown>) {
      const attemptSignal = AbortSignal.any([signal, yield* Effect.abortSignal]);
      const runPromise = yield* FiberSet.makeRuntimePromise();
      let liveHeader: string | null = null;
      const network = new NetworkCore({
        ...options,
        networkConfig: {
          ...options.networkConfig,
          preventAllNetworkTraffic: false,
          networkOverrideFunc: (url, args) =>
            runPromise(fetch(url, args, attemptSignal)).then((response) => {
              liveHeader = response.headers.get("x-statsig-live-overlay-lcut");
              return response;
            }),
        },
      });
      const response = yield* Effect.tryPromise({
        try: () =>
          network.post({
            sdkKey: SDK_KEY,
            urlConfig: new UrlConfiguration(Endpoint._initialize, undefined, API, undefined),
            data,
            retries: 0,
            preserveFailedStatusCode: true,
            isStatsigEncodable: true,
            priority: "low",
          }),
        catch: () => new DictationPolicyClientError({ reason: "network" }),
      });
      if (signal.aborted) return yield* new DictationPolicyClientError({ reason: "aborted" });
      if (response === null) return yield* new DictationPolicyClientError({ reason: "network" });
      if (response.code !== 200 && response.code !== 204)
        return yield* new DictationPolicyClientError({ reason: "http", status: response.code });
      return { ...response, liveHeader };
    },
    Effect.scoped,
    Effect.raceFirst(
      revoked.pipe(
        Effect.andThen(Effect.fail(new DictationPolicyClientError({ reason: "aborted" }))),
      ),
    ),
    // Closing the attempt Scope aborts fetch and body reads, including vendor Promise continuations.
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT_MS,
      orElse: () => Effect.fail(new DictationPolicyClientError({ reason: "timeout" })),
    }),
  );
  const refresh = Effect.fn("DictationPolicyClient.refresh")(function* () {
    const context = client.getContext();
    const response = yield* request({
      user: context.user,
      hash: "djb2",
      ...(initialized
        ? { responseMode: "live_overlay", ...overlay.requestCursor() }
        : { deltasResponseRequested: false, full_checksum: null }),
    });
    if (initialized && response.code === 204) {
      overlay.advance(response.liveHeader);
      return;
    }
    const body = response.body;
    if (body === null || response.code !== 200)
      return yield* new DictationPolicyClientError({ reason: "invalid-response" });
    if (!initialized) {
      const gates = yield* setBaseline(body);
      yield* publishRealtime;
      yield* SubscriptionRef.set(values, gates);
      return;
    }
    const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(body).pipe(
      Effect.mapError(() => new DictationPolicyClientError({ reason: "invalid-response" })),
    );
    const changed = yield* Effect.try({
      try: () => overlay.apply(payload),
      catch: () => new DictationPolicyClientError({ reason: "invalid-response" }),
    });
    if (!changed) return yield* new DictationPolicyClientError({ reason: "invalid-response" });
    yield* publishRealtime;
    yield* SubscriptionRef.set(values, evaluate());
  });
  let failures = 0;
  const attempt = Effect.fn("DictationPolicyClient.attempt")(function* () {
    const operation = initialized ? "live_overlay" : "initialize";
    const result = yield* Effect.result(refresh());
    if (signal.aborted) return yield* new DictationPolicyClientError({ reason: "aborted" });
    if (Result.isSuccess(result)) {
      if (failures > 0)
        yield* Effect.logInfo("Dictation policy refresh recovered").pipe(
          Effect.annotateLogs({ operation, attempts: failures + 1 }),
        );
      failures = 0;
      return overlay.intervalMs;
    }
    failures += 1;
    const jitter = yield* Random.nextBetween(0.8, 1.2);
    const retryMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 4) * jitter);
    const delayMs = initialized ? Math.max(overlay.intervalMs, retryMs) : retryMs;
    if (failures === 1)
      yield* Effect.logWarning("Dictation policy refresh delayed").pipe(
        Effect.annotateLogs({
          operation,
          reason: result.failure.reason,
          status: result.failure.status,
          nextDelayMs: delayMs,
        }),
      );
    return delayMs;
  });
  const initialDelay = initialized ? overlay.intervalMs : yield* attempt();
  if (signal.aborted) return yield* new DictationPolicyClientError({ reason: "aborted" });
  yield* Effect.gen(function* () {
    let delay = initialDelay;
    while (!signal.aborted) {
      yield* Effect.sleep(delay);
      delay = yield* attempt();
    }
  }).pipe(Effect.raceFirst(revoked), Effect.forkScoped);
  return {
    read: SubscriptionRef.get(values),
    changes: SubscriptionRef.changes(values),
    readRealtime: SubscriptionRef.get(realtimeValues),
    realtimeChanges: SubscriptionRef.changes(realtimeValues),
  };
});
