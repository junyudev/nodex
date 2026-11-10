import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import type { components } from "@nodex/core-protocol";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import type { CoreInboxDispatchContext } from "../../main/core-client/inbox-adapter";
import type {
  InboxDispatchAction,
  InboxSkillInvocation,
  InboxSkillTarget,
} from "../../shared/inbox";
import { InboxSkillNameSchema } from "../../shared/schemas/inbox";

export type InboxSkillOffer = components["schemas"]["InboxSkillOffer"];

type SkillDestination = Pick<InboxSkillInvocation, "instanceId" | "cwd">;
type InventorySkill = Pick<InboxSkillInvocation, "name" | "path"> & { description: string };

/** Match standalone invocation tokens in prose, excluding code and escaped markers. */
export function inboxSkillTokens(text: string, prefix: "$" | "/"): string[] {
  const prose = text.replace(
    /^\s{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\s{0,3}\1[\t ]*$|(?![\s\S]))|`([^`\n]*)`/gm,
    "",
  );
  return [
    ...prose.matchAll(
      /(?:^|[\s("'“‘>])(\p{Sc}|\/)(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?=$|[\s,;!?".]))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=$|[\s,;!?")'”’]|\.(?![a-zA-Z0-9]))/gu,
    ),
  ]
    .filter((match) => (match[1] === "/" ? "/" : "$") === prefix)
    .map((match) => match[2]!);
}

/** Background routing uses a bounded cache. Confirmation and delivery always resolve again. */
export const makeInboxSkills = Effect.gen(function* () {
  const runtime = yield* AgentRuntimeApplication;
  const lookup = (destination: SkillDestination) =>
    Effect.suspend(() => runtime.skillsForWorkspace(destination)).pipe(
      Effect.map((skills) => {
        const matches = new Map<string, InventorySkill | null>();
        for (const skill of skills) {
          if (
            !skill.enabled ||
            skill.userInvocable === false ||
            !InboxSkillNameSchema.safeParse(skill.name).success
          )
            continue;
          const previous = matches.get(skill.name);
          if (previous === null || (previous && previous.path !== skill.path)) {
            matches.set(skill.name, null);
            continue;
          }
          matches.set(skill.name, {
            name: skill.name,
            path: skill.path,
            description: (skill.shortDescription ?? skill.description ?? "").slice(0, 160),
          });
        }
        return [...matches.values()]
          .filter((skill) => skill !== null)
          .sort((a, b) => a.name.localeCompare(b.name));
      }),
      Effect.catch(() => Effect.succeed([])),
    );
  const cache = yield* Cache.make({
    capacity: 128,
    timeToLive: "30 seconds",
    lookup: (key: string) => {
      const [instanceId, cwd] = JSON.parse(key) as [string, string];
      return lookup({ instanceId, cwd });
    },
  });
  const destination = (
    action: InboxDispatchAction | InboxSkillTarget,
    instanceId: string | undefined,
  ): Effect.Effect<SkillDestination | null> => {
    if (action.type === "send_to_chat")
      return Effect.suspend(() => runtime.skillDestinationForSession(action.sessionId)).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
    if (action.type !== "new_chat" || !instanceId) return Effect.succeed(null);
    return Effect.suspend(() => runtime.executionWorkspace(action.projectId)).pipe(
      Effect.map((workspace) =>
        workspace.available ? { instanceId, cwd: workspace.workspaceRoot } : null,
      ),
      Effect.catch(() => Effect.succeed(null)),
    );
  };

  const resolve = Effect.fnUntraced(function* (
    action: InboxDispatchAction | InboxSkillTarget,
    instanceId: string | undefined,
    names: readonly string[],
  ) {
    if (!names.length) return [];
    const target = yield* destination(action, instanceId).pipe(
      Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(null) }),
    );
    if (!target) return [];
    const inventory = yield* lookup(target).pipe(
      Effect.timeoutOrElse({
        duration: "3 seconds",
        orElse: () => Effect.succeed([]),
      }),
    );
    return names.flatMap((name): InboxSkillInvocation[] => {
      const skill = inventory.find((candidate) => candidate.name === name);
      return skill ? [{ ...target, name, path: skill.path }] : [];
    });
  });

  const offers = Effect.fnUntraced(function* (
    context: CoreInboxDispatchContext,
    defaultInstance: string | undefined,
    otherInstances: readonly string[],
  ) {
    const projects =
      context.scope.kind === "project"
        ? [context.scope.project_id]
        : [...context.projects.map((project) => project.project_id), null];
    const choices = [
      ...projects
        .slice(0, 4)
        .map((projectId) => ({ projectId, instanceId: null, sessionId: null })),
      ...context.sessions
        .slice(0, 4)
        .map((session) => ({ projectId: null, instanceId: null, sessionId: session.session_id })),
      ...projects.flatMap((projectId) =>
        otherInstances.map((instanceId) => ({ projectId, instanceId, sessionId: null })),
      ),
      ...projects.slice(4).map((projectId) => ({ projectId, instanceId: null, sessionId: null })),
    ].slice(0, 12);
    const collected: InboxSkillOffer[] = [];
    yield* Effect.forEach(
      choices,
      (choice) =>
        Effect.gen(function* () {
          const action: InboxDispatchAction = choice.sessionId
            ? { type: "send_to_chat", sessionId: choice.sessionId, prompt: "", additions: [] }
            : {
                type: "new_chat",
                projectId: choice.projectId,
                agent: null,
                prompt: "",
                additions: [],
              };
          const target = yield* destination(action, choice.instanceId ?? defaultInstance);
          if (!target) return;
          const inventory = yield* Cache.get(
            cache,
            JSON.stringify([target.instanceId, target.cwd]),
          );
          if (!inventory.length) return;
          collected.push({
            project_id: choice.projectId,
            session_id: choice.sessionId,
            instance_id: choice.instanceId,
            skills: inventory.slice(0, 12).map(({ name, description }) => ({ name, description })),
          });
        }),
      { concurrency: 4, discard: true },
    ).pipe(Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }));
    return collected
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      .filter(
        (_, index, all) => Buffer.byteLength(JSON.stringify(all.slice(0, index + 1))) <= 16384,
      );
  });
  return { offers, resolve };
});
