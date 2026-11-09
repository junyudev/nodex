import * as Effect from "effect/Effect";
import { AgentRuntimeApplicationError } from "../main/agent-runtime/AgentRuntimeApplication";
import { captureHostedAppToolAuthority, type AppToolCaller } from "../main/app-tools/AppToolCaller";
import { SessionMessageIntakeError } from "../main/app-tools/SessionMessageIntakeError";
import {
  SessionQuestionError,
  type SessionQuestionBackend,
} from "../main/app-tools/SessionQuestions";
import type { make as makeNativeMessages } from "../main/app-tools/NativeSessionMessageIntake";
import { makeWithNative as makeAttachments } from "../main/app-tools/SessionMessageAttachments";
import { makeWithNative as makeIntake } from "../main/app-tools/SessionMessageIntake";
import { makeWithNative as makeQuestions } from "../main/app-tools/SessionQuestionIntake";
import { makeWithCapture as makeCommands } from "../main/app-tools/RuntimeSessionCommands";
import {
  makeWithNative as makeObservation,
  SessionObservation,
} from "../main/app-tools/SessionObservation";
import { make as makeWaiter, SessionWaiter } from "../main/app-tools/SessionWaiter";
import { makeWithCapture as makeSession } from "../main/app-tools/SessionAppTools";
import { makeWithNative as makeControlAuthority } from "../main/app-tools/SessionControlAuthority";
import { makeWithPorts as makeControls } from "../main/app-tools/SessionControlAppTools";
import { makeSetSessionUnreadWithNative } from "../main/project-application/SessionUnread";
import { ProjectWorkspace } from "../main/project-application/ProjectWorkspace";
import { toolFailure, toolSuccess } from "../main/app-tools/app-tool-result";
import { HostWorkspace } from "./HostWorkspace";
import type { AppToolInvocation } from "../main/app-tools/AppToolInvocationInbox";
import {
  runtimeHostToolCatalog,
  hostToolGroupByName,
  type HostToolGroupExecutor,
} from "./HostToolExecutor";
import { make as makeContent, hostContentToolGroups } from "./HostContentTools";

const hostAppToolGroups = [
  ...hostContentToolGroups,
  "sessionCommands",
  "sessionControls",
  "session",
  "basic",
] as const;
const groups = new Set<string>(hostAppToolGroups);
export const hostAppToolCatalog = runtimeHostToolCatalog.filter(({ name }) =>
  groups.has(hostToolGroupByName.get(name) ?? ""),
);
const names = hostAppToolCatalog.map(({ name }) => name);

/** A team Host has one Runtime writer; native desktop conversation owners are unavailable. */
const nativeUnavailable = (): Effect.Success<typeof makeNativeMessages> => {
  const execution = () =>
    Effect.fail(
      new AgentRuntimeApplicationError({
        operation: "native-session",
        message: "No native execution owner is available",
      }),
    );
  const permission = () =>
    Effect.fail(
      new SessionMessageIntakeError({ message: "No native execution owner is available" }),
    );
  return {
    localHostId: "",
    lookup: () => Effect.succeed(null),
    admit: execution,
    replay: execution,
    reject: execution,
    inspect: permission,
    prepare: permission,
    send: permission,
  };
};
const unavailableQuestions: SessionQuestionBackend = {
  list: () =>
    Effect.fail(
      new SessionQuestionError({
        code: "unsupported",
        message: "No native execution owner is available",
      }),
    ),
  read: () =>
    Effect.fail(
      new SessionQuestionError({
        code: "unsupported",
        message: "No native execution owner is available",
      }),
    ),
  respond: () =>
    Effect.fail(
      new SessionQuestionError({
        code: "unsupported",
        message: "No native execution owner is available",
      }),
    ),
};

export const make = Effect.gen(function* () {
  const content = yield* makeContent;
  const workspace = yield* ProjectWorkspace;
  const paths = yield* HostWorkspace;
  const observations = yield* makeObservation(null);
  const waiter = yield* makeWaiter.pipe(Effect.provideService(SessionObservation, observations));
  const session = yield* makeSession(captureHostedAppToolAuthority).pipe(
    Effect.provideService(SessionObservation, observations),
    Effect.provideService(SessionWaiter, waiter),
  );
  const attachments = yield* makeAttachments(() =>
    Effect.fail(
      new SessionMessageIntakeError({ message: "No native attachment owner is available" }),
    ),
  );
  const intake = yield* makeIntake(nativeUnavailable(), attachments);
  const questions = yield* makeQuestions(unavailableQuestions, intake);
  const command = yield* makeCommands(captureHostedAppToolAuthority, intake, questions);
  const controls = yield* makeControls(
    captureHostedAppToolAuthority,
    null,
    yield* makeControlAuthority(null),
    yield* makeSetSessionUnreadWithNative(null),
  );
  const basic = Effect.fn("HostApplicationTools.basic")(function* (invocation: AppToolInvocation) {
    const { caller, name, arguments: input } = invocation;
    if (Object.keys(input).length) return toolFailure("invalid_arguments");
    if (name === "get_app_capabilities")
      return toolSuccess({
        tools: [...names],
        transport: "native_mcp",
        contentAccess: "scoped_core",
      });
    if (name !== "list_projects") return toolFailure("tool_unavailable");
    const projects = yield* workspace.listProjects.pipe(
      Effect.flatMap((items) =>
        Effect.forEach(items, (project) =>
          paths.resolve(project.sources).pipe(
            Effect.map((roots) => ({
              projectId: project.id,
              name: project.name,
              path: roots[0] ?? null,
              hostId: "local",
            })),
          ),
        ),
      ),
    );
    return caller.isActive() ? toolSuccess({ projects }) : toolFailure("call_withdrawn");
  });
  const executors = {
    ...content,
    session,
    sessionControls: controls,
    sessionCommands: command,
    basic: (input) =>
      basic(input).pipe(Effect.catch(() => Effect.succeed(toolFailure("host_tool_failed")))),
  } satisfies Record<(typeof hostAppToolGroups)[number], HostToolGroupExecutor>;
  const execute = Effect.fn("HostApplicationTools.execute")(function* (
    caller: AppToolCaller,
    name: string,
    input: Record<string, unknown>,
  ) {
    const group = hostAppToolGroups.find((group) => group === hostToolGroupByName.get(name));
    if (!group) return toolFailure("tool_unavailable");
    if (!(yield* captureHostedAppToolAuthority(caller)))
      return toolFailure("authority_unavailable");
    return yield* executors[group]({ caller, name, arguments: input });
  });
  return (caller: AppToolCaller, name: string, input: Record<string, unknown>) =>
    execute(caller, name, input).pipe(
      Effect.catch(() => Effect.succeed(toolFailure("host_tool_failed"))),
    );
});
