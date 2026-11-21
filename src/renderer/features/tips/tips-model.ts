import { parseAgentRuntimeToolName } from "@/features/local-conversation/agent-runtime-transcript-projection";

/**
 * A tip introduces one thing at the moment a person first meets it, in one quiet sentence above
 * the Composer, with a way to try it. Listed most timely first: what is on screen now comes before
 * what could be done next, and a question about later comes last.
 */
export const TIP_IDS = [
  "page",
  "second-opinion",
  "second-agent",
  "notifications",
  "inbox",
] as const;
export type TipId = (typeof TIP_IDS)[number];

export interface TipsState {
  /** The person's own switch in Settings → General. */
  readonly on: boolean;
  /** Tips that have had their turn: acted on, dismissed, or passed by. They never return. */
  readonly settled: readonly TipId[];
}

const isTipId = (value: unknown): value is TipId => TIP_IDS.includes(value as TipId);

export const normalizeSettledTips = (value: unknown): readonly TipId[] =>
  Array.isArray(value) ? [...new Set(value.filter(isTipId))] : [];

/** The same list when nothing new settles, so a repeat costs no write. */
export const settleTips = (settled: readonly TipId[], tips: readonly TipId[]): readonly TipId[] =>
  tips.every((tip) => settled.includes(tip)) ? settled : [...new Set([...settled, ...tips])];

/** What a chat knows when it decides whether to speak. */
export interface TipMoment {
  /** An unstarted chat is New Chat. */
  readonly started: boolean;
  readonly working: boolean;
  /** Each rest after a finished Run is one moment, with room for one tip. */
  readonly finishedRuns: number;
  /** The Agent wrote or opened a Page in the Run that just finished. */
  readonly pageOpened: boolean;
  /** Another Agent this chat's Agent could hand work to, by name. */
  readonly teammate: string | null;
  /** Another Agent has already worked in this chat. */
  readonly teamedUp: boolean;
  readonly canConnectAgent: boolean;
  /** The system hasn't been asked about notifications yet. */
  readonly notificationsUndecided: boolean;
  readonly otherChatWorking: boolean;
}

/** The tips this moment has a use for, most timely first. */
export function timelyTips(moment: TipMoment): readonly TipId[] {
  const rested = moment.started && moment.finishedRuns > 0;
  const use: Record<TipId, boolean> = {
    page: rested && moment.pageOpened,
    "second-opinion": rested && !moment.teamedUp && moment.teammate !== null,
    "second-agent":
      rested && !moment.teamedUp && moment.teammate === null && moment.canConnectAgent,
    notifications: rested && moment.notificationsUndecided,
    inbox: !moment.started && moment.otherChatWorking,
  };
  return TIP_IDS.filter((tip) => use[tip]);
}

/** Tips a person no longer needs: Agents that have worked together need no introduction. */
export const outgrownTips = (moment: Pick<TipMoment, "teamedUp">): readonly TipId[] =>
  moment.teamedUp ? ["second-opinion", "second-agent"] : [];

/** The tip a chat showed, and the rest it showed it in. */
export interface ShownTip {
  readonly tip: TipId;
  readonly finishedRuns: number;
}

/**
 * At most one tip per rest, and none while the Agent works. A tip stays for its rest until it is
 * settled, and settling it leaves the rest quiet instead of bringing up the next one.
 */
export function chooseTip(input: {
  readonly state: TipsState;
  readonly moment: TipMoment;
  readonly shown: ShownTip | null;
}): TipId | null {
  const { state, moment, shown } = input;
  if (!state.on || moment.working) return null;
  const open = timelyTips(moment).filter((tip) => !state.settled.includes(tip));
  if (shown && shown.finishedRuns === moment.finishedRuns)
    return open.includes(shown.tip) ? shown.tip : null;
  return open[0] ?? null;
}

interface ChatRun {
  readonly id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly modelSelection: { readonly instanceId: string };
}

const WORKING: readonly string[] = ["preparing", "queued", "starting", "running", "waiting"];

const opensPage = (input: unknown): boolean =>
  typeof input === "object" &&
  input !== null &&
  (input as { target?: { kind?: unknown } }).target?.kind === "page";

/** What a chat's own record says about the moment. */
export function chatTipFacts(
  projection:
    | {
        readonly runs: readonly ChatRun[];
        readonly subagents: readonly {
          readonly origin: string;
          readonly runId: string | null;
          readonly providerInstanceId: string;
        }[];
        readonly visibleTurnItems: readonly {
          readonly item: {
            readonly type: string;
            readonly status?: string;
            readonly runId?: string | null;
            readonly toolName?: string | null;
            readonly input?: unknown;
          };
        }[];
      }
    | undefined,
): Pick<TipMoment, "working" | "finishedRuns" | "pageOpened" | "teamedUp"> {
  const runs = projection?.runs ?? [];
  const finished = runs.filter((run) => run.status === "completed");
  const latest = finished.reduce<ChatRun | undefined>(
    (previous, run) => (!previous || run.ordinal > previous.ordinal ? run : previous),
    undefined,
  );
  const working = runs.some((run) => WORKING.includes(run.status));
  const agentOfRun = new Map(runs.map((run) => [run.id, run.modelSelection.instanceId]));
  return {
    working,
    finishedRuns: finished.length,
    // Read only at rest: a chat says nothing while it works, and its record changes with every
    // word the Agent writes. The same calls put `Created` and `Opened` in the transcript.
    pageOpened:
      !working &&
      latest !== undefined &&
      (projection?.visibleTurnItems ?? []).some(({ item }) => {
        if (item.type !== "dynamic_tool" || item.runId !== latest.id) return false;
        if (item.status !== "completed") return false;
        const { namespace, tool } = parseAgentRuntimeToolName(item.toolName ?? null);
        if (namespace !== "nodex_app") return false;
        return tool === "create_pages" || (tool === "open_in_nodex" && opensPage(item.input));
      }),
    // Only work handed over through Nodex crosses Agents; an Agent's own subagents stay inside
    // it. A helper differs from the Agent of the Run that asked for it, whatever ran later.
    teamedUp: (projection?.subagents ?? []).some((task) => {
      const asker = task.runId === null ? undefined : agentOfRun.get(task.runId);
      return (
        task.origin === "app_owned" && asker !== undefined && asker !== task.providerInstanceId
      );
    }),
  };
}
