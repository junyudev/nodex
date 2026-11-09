import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { makeNativeSessionHistory } from "./NativeSessionHistory";
import { makeNativeSessionReadDetails } from "./NativeSessionReadDetails";
import { make as makeNativeExecution } from "./NativeSessionExecution";
import { makeNativeSessionSearch } from "./NativeSessionSearch";
import { makeWithNative, SessionObservation } from "./SessionObservation";

export const make = Effect.gen(function* () {
  const directory = yield* CodexThreadDirectory;
  const history = yield* makeNativeSessionHistory;
  const details = yield* makeNativeSessionReadDetails;
  const execution = yield* makeNativeExecution;
  const search = yield* makeNativeSessionSearch;
  return yield* makeWithNative({ directory, history, details, execution, search });
});
export const live = Layer.effect(SessionObservation, make);
