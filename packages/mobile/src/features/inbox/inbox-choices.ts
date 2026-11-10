import { LIBRARY_INBOX, type InboxScope, type Project } from "@nodex/mobile-protocol";

import type { IconName } from "../../ui/icons";

/** One Inbox a Space offers: its Library's, or a Project's. */
export interface InboxChoice {
  readonly key: string;
  readonly scope: InboxScope;
  readonly icon: IconName;
  readonly label: string;
  /** How many messages wait in it. */
  readonly count: number;
  readonly selected: boolean;
}

export interface InboxChoices {
  readonly library: InboxChoice;
  readonly projects: readonly InboxChoice[];
  /**
   * The one being shown. None when that is a Project its Space has not listed yet or no longer
   * has, which still must not pass for the Library.
   */
  readonly shown: InboxChoice | undefined;
}

/** Every Inbox of a Space, marking the one `shown` names, however it spells the Library's. */
export const inboxChoices = (
  space: { readonly projects: readonly Project[]; readonly libraryInboxCount: number },
  shown: InboxScope,
): InboxChoices => {
  const library: InboxChoice = {
    key: "library",
    scope: LIBRARY_INBOX,
    icon: "inbox",
    label: "Library",
    count: space.libraryInboxCount,
    selected: shown.kind !== "project",
  };
  const projects = space.projects.map((project): InboxChoice => ({
    key: project.id,
    scope: { kind: "project", projectId: project.id },
    icon: "folder",
    label: project.name,
    count: project.inboxCount,
    selected: shown.kind === "project" && shown.projectId === project.id,
  }));
  return {
    library,
    projects,
    shown: library.selected ? library : projects.find((project) => project.selected),
  };
};

/** The resting Composer's words: a thought dropped here goes to the Library unless it says where. */
export const capturePrompt = (shown: InboxChoice | undefined): string =>
  shown?.scope.kind === "project" ? `Drop a thought in ${shown.label}` : "Drop a thought";
