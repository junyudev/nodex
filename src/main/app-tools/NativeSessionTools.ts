import * as Effect from "effect/Effect";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CodexThreadReadState } from "../codex-application/CodexThreadReadState";
import { makeSetSessionUnreadWithNative } from "../project-application/SessionUnread";
import { captureAppToolAuthority, type AppToolAuthorityCapture } from "./AppToolCaller";
import { make as makeNativeMessages } from "./NativeSessionMessageIntake";
import { make as makeNativeAttachments } from "./NativeSessionMessageAttachments";
import { makeNativeSessionQuestions } from "./NativeSessionQuestions";
import { make as makeNativePermissions } from "./NativeSessionPermissionFacts";
import { make as makeNativeControls } from "../codex-application/CodexSessionControls";
import { makeWithNative as makeAttachments } from "./SessionMessageAttachments";
import { makeWithNative as makeIntake } from "./SessionMessageIntake";
import { makeWithNative as makeQuestions } from "./SessionQuestionIntake";
import { makeWithNative as makeAuthority } from "./SessionControlAuthority";
import { makeWithPorts as makeControlsWithPorts } from "./SessionControlAppTools";
import { makeWithCapture as makeRuntimeCommands } from "./RuntimeSessionCommands";

/** Main supplies the existing native conversation owners to the shared Session semantics. */
export const makeMessageIntake = Effect.gen(function* () {
  const native = yield* makeNativeMessages;
  const attachments = yield* makeAttachments(yield* makeNativeAttachments);
  return yield* makeIntake(native, attachments);
});
const makeQuestionIntake = Effect.gen(function* () {
  return yield* makeQuestions(yield* makeNativeSessionQuestions, yield* makeMessageIntake);
});
export const makeControlAuthority = Effect.gen(function* () {
  return yield* makeAuthority(yield* makeNativePermissions);
});
export const makeSetSessionUnread = Effect.gen(function* () {
  return yield* makeSetSessionUnreadWithNative(yield* CodexThreadReadState);
});
export const makeControlsWithCapture = (capture: AppToolAuthorityCapture) =>
  Effect.gen(function* () {
    return yield* makeControlsWithPorts(
      capture,
      yield* makeNativeControls,
      yield* makeControlAuthority,
      yield* makeSetSessionUnread,
    );
  });
export const makeControls = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeControlsWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
export const makeCommands = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeRuntimeCommands(
    (caller) => captureAppToolAuthority(caller, turns),
    yield* makeMessageIntake,
    yield* makeQuestionIntake,
  );
});
