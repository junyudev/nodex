import * as Schema from "effect/Schema";
import { statsigNameHash } from "./DictationPolicyState";

const Timestamp = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const EvaluationValue = Schema.Struct({ value: Schema.optionalKey(Schema.Unknown) });
const Evaluations = Schema.Record(Schema.String, Schema.Unknown);
const LiveEntityNames = Schema.Struct({
  feature_gates: Schema.optionalKey(Schema.Array(Schema.String)),
  dynamic_configs: Schema.optionalKey(Schema.Array(Schema.String)),
  experiments: Schema.optionalKey(Schema.Array(Schema.String)),
});
const liveFields = {
  time: Timestamp,
  live_entity_names: LiveEntityNames,
  feature_gates: Schema.optionalKey(Schema.NullOr(Evaluations)),
  dynamic_configs: Schema.optionalKey(Schema.NullOr(Evaluations)),
  derived_fields: Schema.optionalKey(Schema.Unknown),
  full_checksum: Schema.optionalKey(Schema.NullOr(Schema.String)),
};
const BootstrapPayload = Schema.Struct({
  ...liveFields,
  has_updates: Schema.Literal(true),
  response_format: Schema.optionalKey(Schema.String),
});
const LiveOverlayPayload = Schema.Struct({
  ...liveFields,
  response_mode: Schema.Literal("live_overlay"),
});
const RefreshInterval = Schema.Struct({
  sdk_configs: Schema.Struct({
    live_values_auto_refresh_interval_seconds: Schema.Number.check(
      Schema.isFinite(),
      Schema.isGreaterThan(0),
    ),
  }),
});
const decodeBootstrap = Schema.decodeUnknownOption(BootstrapPayload);
const decodeOverlay = Schema.decodeUnknownOption(LiveOverlayPayload);
const decodeInterval = Schema.decodeUnknownOption(RefreshInterval);
const decodeEvaluation = Schema.decodeUnknownOption(EvaluationValue);
const decodeTimestamp = Schema.decodeUnknownOption(Timestamp);

type Evaluation = { readonly value: unknown };
type Entities = {
  readonly names: ReadonlySet<string>;
  readonly values: typeof Evaluations.Type;
  readonly retained: ReadonlyMap<string, Evaluation>;
};
type LiveValues = {
  readonly time: number;
  readonly previousDerivedFields: unknown;
  readonly fullChecksum: string | undefined;
  readonly gates: Entities;
  readonly configs: Entities;
};

export interface DictationLiveValues {
  readonly intervalMs: number;
  requestCursor(): {
    sinceTime?: number;
    previousDerivedFields?: unknown;
    full_checksum?: string;
  };
  apply(response: unknown): boolean;
  advance(header: string | null): void;
  gate(name: string, baselineValue: boolean): boolean;
  config(name: string, baselineValue: unknown): unknown;
}

const toLiveValues = (
  payload: typeof BootstrapPayload.Type | typeof LiveOverlayPayload.Type,
): LiveValues => {
  const liveNames = payload.live_entity_names;
  return {
    time: payload.time,
    previousDerivedFields: payload.derived_fields,
    fullChecksum: payload.full_checksum ?? undefined,
    gates: {
      names: new Set(liveNames.feature_gates),
      values: payload.feature_gates ?? {},
      retained: new Map(),
    },
    configs: {
      names: new Set([...(liveNames.dynamic_configs ?? []), ...(liveNames.experiments ?? [])]),
      values: payload.dynamic_configs ?? {},
      retained: new Map(),
    },
  };
};

const includesName = (set: ReadonlySet<string>, name: string): boolean =>
  set.has(name) || set.has(statsigNameHash(name));

const ownValue = (values: typeof Evaluations.Type, name: string): unknown =>
  Object.hasOwn(values, name) ? values[name] : undefined;

const evaluation = (entities: Entities, name: string): Evaluation => {
  const result = decodeEvaluation(
    ownValue(entities.values, name) ?? ownValue(entities.values, statsigNameHash(name)),
  );
  return { value: result._tag === "Some" ? result.value.value : undefined };
};

const override = (entities: Entities | undefined, name: string): Evaluation | undefined => {
  if (!entities) return undefined;
  if (includesName(entities.names, name)) return evaluation(entities, name);
  return entities.retained.get(name) ?? entities.retained.get(statsigNameHash(name));
};

const retainDropped = (previous: Entities, next: Entities): Entities => {
  const retained = new Map(previous.retained);
  const nextNames = new Set([...next.names].flatMap((name) => [name, statsigNameHash(name)]));
  for (const name of previous.names) {
    if (!includesName(nextNames, name)) retained.set(name, evaluation(previous, name));
  }
  for (const name of retained.keys()) {
    if (includesName(nextNames, name)) retained.delete(name);
  }
  return { ...next, retained };
};

/**
 * Keeps live evaluations separate from SDK baseline values. The caller validates
 * identity and opts into a bootstrap cursor only after verifying its full user hash.
 */
export const makeDictationLiveValues = (
  baseline: unknown,
  seedCursorValid = false,
): DictationLiveValues => {
  const interval = decodeInterval(baseline);
  const intervalMs =
    interval._tag === "Some"
      ? interval.value.sdk_configs.live_values_auto_refresh_interval_seconds * 1_000
      : 600_000;
  const payload = decodeBootstrap(baseline);
  let live =
    payload._tag === "Some" && payload.value.response_format !== "init-v2"
      ? toLiveValues(payload.value)
      : undefined;
  // Bootstrap seeds derived fields, but its full checksum is not a live checksum.
  if (live) live = { ...live, fullChecksum: undefined };
  let cursorValid = live !== undefined && seedCursorValid;

  return {
    intervalMs,
    requestCursor: () => {
      if (!live || !cursorValid) return {};
      return {
        sinceTime: live.time,
        previousDerivedFields: live.previousDerivedFields,
        ...(live.fullChecksum === undefined ? {} : { full_checksum: live.fullChecksum }),
      };
    },
    apply: (response) => {
      const value = decodeOverlay(response);
      if (value._tag === "None") return false;
      const next = toLiveValues(value.value);
      if (live && cursorValid && next.time < live.time) return false;
      live =
        live && cursorValid
          ? {
              ...next,
              gates: retainDropped(live.gates, next.gates),
              configs: retainDropped(live.configs, next.configs),
            }
          : next;
      cursorValid = true;
      return true;
    },
    advance: (header) => {
      if (!live || !cursorValid || header === null || header.trim() === "") return;
      const time = decodeTimestamp(Number(header));
      if (time._tag === "None" || time.value < live.time) return;
      live = { ...live, time: time.value };
    },
    gate: (name, baselineValue) => {
      const result = override(live?.gates, name);
      return result === undefined ? baselineValue : result.value === true;
    },
    config: (name, baselineValue) => {
      const result = override(live?.configs, name);
      return result === undefined ? baselineValue : (result.value ?? {});
    },
  };
};
