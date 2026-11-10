import { LIBRARY_INBOX, type InboxScope } from "@nodex/mobile-protocol";

import { useHosts, useProjects } from "../../runtime";
import { useHomeState } from "../home/home-state";
import { inboxChoices } from "./inbox-choices";

/** The Inbox the current Space shows, its Library's until another is chosen, and how to choose. */
export const useInboxScope = (): {
  readonly scope: InboxScope;
  readonly setScope: (scope: InboxScope) => void;
} => {
  const { activeHostId } = useHosts();
  const scope = useHomeState(
    (state) => (activeHostId ? state.scopes[activeHostId] : undefined) ?? LIBRARY_INBOX,
  );
  return {
    scope,
    setScope: (next) => {
      if (activeHostId) useHomeState.getState().setScope(activeHostId, next);
    },
  };
};

/** The current Space's Inboxes, the one being shown, and how to show another. */
export const useInboxChoices = () => {
  const { scope, setScope } = useInboxScope();
  return { ...inboxChoices(useProjects(), scope), scope, choose: setScope };
};
