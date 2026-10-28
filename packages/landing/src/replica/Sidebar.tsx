import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { PROJECTS, type ProjectName, type ProviderKind } from "../demos/lumen";
import {
  InboxIcon,
  NewChatIcon,
  ProjectFolderIcon,
  ProjectFolderOpenIcon,
  SpinnerIcon,
} from "./icons";
import { SidebarHeader, SidebarRow, SidebarSection } from "./Window";

export interface SidebarChat {
  readonly title: string;
  readonly project: ProjectName;
  readonly provider: ProviderKind;
  readonly working: boolean;
  readonly unread?: boolean;
}

export type SidebarSelection =
  | { readonly kind: "inbox" }
  | { readonly kind: "project"; readonly name: ProjectName }
  | { readonly kind: "chat"; readonly title: string };

/** The Home sidebar uses chat status, rather than provider identity, in its trailing slot. */
export function AppSidebar({
  chats,
  inboxCount = 0,
  projectInboxCounts,
  selection,
}: {
  readonly chats: readonly SidebarChat[];
  readonly inboxCount?: number;
  readonly projectInboxCounts?: Partial<Readonly<Record<ProjectName, number>>>;
  readonly selection: SidebarSelection;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <div className="flex min-h-0 flex-1 flex-col pb-[9.84px]">
      <SidebarHeader />
      <div className="flex shrink-0 flex-col gap-[0.82px] pb-[6.56px]">
        <SidebarRow
          icon={<InboxIcon />}
          label="Inbox"
          active={selection.kind === "inbox"}
          trailing={
            inboxCount > 0 ? (
              <span className="text-[9.84px] text-app-faint tabular-nums">{inboxCount}</span>
            ) : null
          }
        />
        <SidebarRow icon={<NewChatIcon />} label="New chat" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SidebarSection title="Projects">
          {PROJECTS.map((project) => {
            const projectChats = chats.filter((chat) => chat.project === project);
            const expanded =
              projectChats.length > 0 ||
              (selection.kind === "project" && selection.name === project);
            const count = projectInboxCounts?.[project] ?? 0;
            return (
              <div key={project} className="flex flex-col">
                <SidebarRow
                  icon={expanded ? <ProjectFolderOpenIcon /> : <ProjectFolderIcon />}
                  label={project}
                  active={selection.kind === "project" && selection.name === project}
                  trailing={
                    count > 0 ? (
                      <span className="pr-[4.92px] text-[9.84px] text-app-faint tabular-nums">
                        {count}
                      </span>
                    ) : null
                  }
                />
                <AnimatePresence initial={false}>
                  {projectChats.map((chat) => (
                    <motion.div
                      key={chat.title}
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 24.6 }}
                      transition={{ duration: reducedMotion ? 0 : 0.3 }}
                      className="overflow-hidden"
                    >
                      <SidebarRow
                        indent
                        label={chat.title}
                        active={selection.kind === "chat" && selection.title === chat.title}
                        cursorTarget={`chat:${chat.title}`}
                        trailing={
                          chat.working || chat.unread ? (
                            <span className="-mr-[3.28px] flex size-[16.4px] shrink-0 items-center justify-center">
                              {chat.working ? (
                                <SpinnerIcon
                                  className="size-[13.12px] text-app-muted"
                                  animationDurationMs={2_000}
                                />
                              ) : (
                                <span
                                  aria-label="Unread"
                                  className="size-[6.56px] rounded-full bg-[#3a83f7]"
                                />
                              )}
                            </span>
                          ) : null
                        }
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            );
          })}
        </SidebarSection>
        <SidebarSection title="Chats">
          <div className="px-[13.12px] py-[6.56px] text-[10.66px] text-app-faint">
            No projectless chats
          </div>
        </SidebarSection>
      </div>
    </div>
  );
}
