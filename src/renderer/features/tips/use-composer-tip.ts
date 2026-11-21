import { useEffect, useState, useSyncExternalStore } from "react";
import { useIntl } from "@/lib/i18n";
import {
  agentRuntimeActivityStore,
  type AgentRuntimeActivityStore,
} from "@/lib/agent-runtime-session-activity";
import { composerDraftIntents, type ComposerChatKey } from "@/lib/composer-draft-intents";
import { useDesktopNotificationAuthorization } from "@/lib/desktop-notification-authorization";
import type { ComposerTip } from "@/features/local-conversation/thread-stage-types";
import {
  TIP_IDS,
  chooseTip,
  outgrownTips,
  type ShownTip,
  type TipId,
  type TipMoment,
} from "./tips-model";
import { useTipsNavigation } from "./tips-navigation";
import { useTipsState } from "./tips-state";

const never = () => () => {};

/** Whether any other chat is at work; a null Session asks nothing and subscribes to nothing. */
function useOtherChatWorking(
  sessionId: string | null,
  store: AgentRuntimeActivityStore = agentRuntimeActivityStore,
): boolean {
  return useSyncExternalStore(sessionId ? store.subscribeAll : never, () => {
    if (!sessionId) return false;
    for (const [other, activity] of store.readAll())
      if (other !== sessionId && activity.status === "running") return true;
    return false;
  });
}

/**
 * The tip a chat has for its person right now. A tip has its turn once: acting on it, dismissing
 * it, or carrying on past it all settle it for good.
 */
export function useComposerTip(input: {
  /** A person's own chats speak; an Agent's helpers and side chats stay quiet. */
  readonly enabled: boolean;
  readonly sessionId: string;
  readonly chat: ComposerChatKey;
  readonly moment: Omit<TipMoment, "notificationsUndecided" | "otherChatWorking">;
  readonly connectAgent: () => void;
}): ComposerTip | null {
  const intl = useIntl();
  const { state, settle } = useTipsState();
  const navigation = useTipsNavigation();
  const { moment: facts, sessionId } = input;
  const live = input.enabled && state !== null && state.on;
  const waiting = (tip: TipId) => live && !state.settled.includes(tip);

  // Each outside fact is read only while its tip could still be said.
  const rested = facts.started && !facts.working && facts.finishedRuns > 0;
  const authorization = useDesktopNotificationAuthorization(waiting("notifications") && rested);
  const otherChatWorking = useOtherChatWorking(
    waiting("inbox") && navigation !== null && !facts.started ? sessionId : null,
  );
  const moment: TipMoment = {
    ...facts,
    notificationsUndecided: authorization.query.data === "not-determined",
    otherChatWorking,
  };

  const [shown, setShown] = useState<
    | (ShownTip & {
        readonly sessionId: string;
        /** The tip this one took over from, when a new rest arrived with no work seen between. */
        readonly after: TipId | null;
      })
    | null
  >(null);
  const current = shown?.sessionId === sessionId ? shown : null;
  const tip = live ? chooseTip({ state, moment, shown: current }) : null;
  if (tip && (current?.tip !== tip || current.finishedRuns !== moment.finishedRuns))
    setShown({
      sessionId,
      tip,
      finishedRuns: moment.finishedRuns,
      after: current && current.tip !== tip ? current.tip : null,
    });

  // Carrying on past a tip is an answer too: it had its moment and doesn't come back.
  const passed = !current
    ? null
    : moment.working || current.finishedRuns !== moment.finishedRuns
      ? current.tip
      : current.after;
  const outgrown = outgrownTips(moment);
  const due = TIP_IDS.filter((id) => id === passed || (outgrown.includes(id) && waiting(id))).join(
    ",",
  );
  useEffect(() => {
    const tips = TIP_IDS.filter((id) => due.split(",").includes(id));
    if (tips.length) settle(...tips);
  }, [due, settle]);

  if (!tip) return null;
  const dismiss = () => settle(tip);
  const { teammate } = moment;
  switch (tip) {
    case "page":
      return {
        key: "tip:page",
        text: intl.formatMessage({
          id: "tips.page",
          defaultMessage:
            "That’s a Page: you and your agents can both edit it. Mention it with @ in any chat.",
        }),
        dismiss,
      };
    case "second-opinion":
      return {
        key: "tip:second-opinion",
        text: intl.formatMessage(
          {
            id: "tips.secondOpinion",
            defaultMessage: "Want a second opinion? {teammate} can review this.",
          },
          { teammate },
        ),
        action: {
          label: intl.formatMessage(
            { id: "tips.secondOpinion.action", defaultMessage: "Ask {teammate}" },
            { teammate },
          ),
          run: () => {
            // The request lands in the Composer unsent, after anything already drafted there:
            // asking by name is the whole trick, and sending it stays the person's move.
            const request = intl.formatMessage(
              {
                id: "tips.secondOpinion.prompt",
                defaultMessage:
                  "Ask {teammate} to review your work above, then tell me what you’d change.",
              },
              { teammate },
            );
            composerDraftIntents.set(input.chat, {
              prompt: "",
              attachmentMode: "append",
              promptInput: { text: request, documentItems: [{ type: "text", text: request }] },
              focusNonce: Date.now(),
            });
            settle(tip);
          },
        },
        dismiss,
      };
    case "second-agent":
      return {
        key: "tip:second-agent",
        text: intl.formatMessage({
          id: "tips.secondAgent",
          defaultMessage: "With a second agent connected, they can check each other’s work.",
        }),
        action: {
          label: intl.formatMessage({ id: "tips.secondAgent.action", defaultMessage: "Connect" }),
          run: () => {
            settle(tip);
            input.connectAgent();
          },
        },
        dismiss,
      };
    case "notifications":
      return {
        key: "tip:notifications",
        text: intl.formatMessage({
          id: "tips.notifications",
          defaultMessage: "Get a notification when an agent finishes?",
        }),
        action: {
          label: intl.formatMessage({ id: "tips.notifications.action", defaultMessage: "Turn on" }),
          pendingLabel: intl.formatMessage({
            id: "tips.notifications.asking",
            defaultMessage: "Asking…",
          }),
          // Nothing is asked of the system until the person says yes.
          run: async () => {
            await authorization.request.mutateAsync();
            settle(tip);
          },
        },
        dismiss,
      };
    case "inbox":
      return {
        key: "tip:inbox",
        text: intl.formatMessage({
          id: "tips.inbox",
          defaultMessage:
            "More on your mind? Drop it in the Inbox and Nodex suggests where it should go.",
        }),
        action: {
          label: intl.formatMessage({ id: "tips.inbox.action", defaultMessage: "Open Inbox" }),
          run: () => {
            settle(tip);
            navigation?.openInbox();
          },
        },
        dismiss,
      };
  }
}
