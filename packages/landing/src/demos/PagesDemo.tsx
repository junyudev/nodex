import { useRef } from "react";
import { LayoutGroup } from "motion/react";
import { BoardCardView, BoardColumn, STATUSES, type BoardCard } from "../replica/Board";
import { AppWindow, NewTab, PaneHeader, PaneTab, Tab, TabGroupContent } from "../replica/Window";
import {
  BoardIcon,
  CanvasViewIcon,
  DatabaseFilterIcon,
  DatabaseSettingsIcon,
  DatabaseSortIcon,
  InboxIcon,
  ListIcon,
  PageIcon,
  PlusIcon,
  SearchIcon,
} from "../replica/icons";
import {
  FilesProperty,
  Flamegraph,
  PAGE_FILE_ICON,
  PagePanel,
  TaskProperties,
} from "../replica/Page";
import { AgentDock } from "../replica/AgentDock";
import { AppSidebar, type SidebarChat } from "../replica/Sidebar";
import { Stage } from "../replica/Stage";
import { FileView } from "../replica/Viewers";
import { CAPTURE_DEMOS } from "./capture-demos";
import { Cursor } from "./Cursor";
import { ColdStartFindings } from "./ColdStartFindings";
import { AGENTS, COLD_START_FILES, COLD_START_FINDINGS, INBOX_BURST } from "./lumen";
import { useTimeline, type Cue, type Timeline } from "./timeline";

const COLD_START_MESSAGE = INBOX_BURST.find((message) => message.id === "coldstart")!.text;
const FLAMEGRAPH = COLD_START_FILES[0].files[1];

const CARDS: readonly BoardCard[] = [
  {
    id: "audit",
    title: "Audit log export",
    body: "CSV and JSON exports for workspace admins.",
    status: "Triage",
  },
  {
    id: "onboarding",
    title: "Onboarding checklist copy",
    body: "Shorter steps, one action each.",
    status: "Triage",
  },
  {
    id: "digest",
    title: "Weekly workspace digest",
    body: "A weekly snapshot for workspace owners.",
    status: "Plan",
  },
  {
    id: "passkeys",
    title: "Passkey sign-in",
    body: "Replace password sign-in with passkeys; keep passwords for one release.",
    status: "Build",
    chat: { provider: "claude", working: true },
  },
  {
    id: "webhooks",
    title: "Idempotent Stripe webhooks",
    body: "Overlapping retries must never charge twice.",
    status: "Build",
    chat: { provider: "codex", working: true },
  },
  {
    id: "coldstart",
    title: "Dashboard cold start",
    body: "Profile the cold start and report the three biggest costs.",
    status: "Build",
    chat: { provider: "opencode", working: true },
  },
  {
    id: "settings",
    title: "Settings dark mode",
    body: "Contrast on surfaces and secondary text.",
    status: "Review",
  },
  {
    id: "ratelimit",
    title: "Rate limiter",
    body: "Per-workspace limits on the public API.",
    status: "Ship",
  },
];

const PROJECT_CHATS: readonly SidebarChat[] = [
  { title: "Passkey sign-in", project: "lumen-web", provider: "claude", working: true },
  { title: "Dashboard cold start", project: "lumen-web", provider: "opencode", working: false },
  { title: "Settings redesign", project: "lumen-web", provider: "claude", working: false },
];

const FINDINGS_AT = COLD_START_FINDINGS.map((_, index) => 3500 + index * 550);

const CUES: readonly Cue[] = [
  { id: "move", at: 700 },
  { id: "aim:card", at: 1500 },
  { id: "press:card", at: 2150 },
  { id: "open", at: 2300 },
  ...FINDINGS_AT.map((at, index) => ({ id: `finding:${index}`, at })),
  { id: "attach", at: 5600 },
  { id: "aim:files", at: 6400 },
  { id: "press:files", at: 6950 },
  { id: "files", at: 7100 },
  { id: "aim:image", at: 8000 },
  { id: "press:image", at: 8550 },
  { id: "preview", at: 8700 },
  { id: "rest", at: 9300 },
];

/** The Board moving on its own while agents work, and a Page an agent is writing into. */
export default function PagesDemo() {
  const root = useRef<HTMLDivElement | null>(null);
  const timeline = useTimeline({ cues: CUES, durationMs: 12800 }, root);
  const { reached } = timeline;
  const statusOf = (card: BoardCard) =>
    card.id === "coldstart" && reached("move") ? "Review" : card.status;
  const cards = CARDS.map((card) =>
    card.id === "coldstart" && reached("move")
      ? {
          ...card,
          status: "Review" as const,
          chat: { provider: "opencode" as const, working: false },
        }
      : card,
  );
  const open = reached("open");
  const previewing = reached("preview");
  const target = reached("rest")
    ? null
    : reached("aim:image")
      ? "file:flamegraph.png"
      : reached("aim:files")
        ? "files"
        : reached("aim:card") && !open
          ? "card:coldstart"
          : null;
  const pressed =
    (reached("press:card") && !open) ||
    (reached("press:files") && !reached("files")) ||
    (reached("press:image") && !reached("preview"));

  return (
    <div ref={root} className="w-full">
      <Stage {...CAPTURE_DEMOS.pages} compactWidth={640} compactHeight={760}>
        {({ compact }) => (
          <AppWindow
            key={timeline.loop}
            sidebar={
              compact ? undefined : (
                <AppSidebar
                  chats={PROJECT_CHATS}
                  selection={{ kind: "project", name: "lumen-web" }}
                />
              )
            }
            tabs={
              <>
                <Tab icon={<InboxIcon className="size-4" />} label="Inbox" />
                <Tab icon={<BoardIcon className="size-4" />} label="lumen-web" active />
              </>
            }
            side={
              open
                ? {
                    tabs: (
                      <>
                        <Tab
                          icon={<PageIcon className="size-4" />}
                          label="Dashboard cold start"
                          active={!previewing}
                        />
                        {previewing ? (
                          <NewTab>
                            <Tab icon={PAGE_FILE_ICON.image} label={FLAMEGRAPH.name} active />
                          </NewTab>
                        ) : null}
                      </>
                    ),
                    width: compact ? 420 : 470,
                    children: (
                      <TabGroupContent
                        group={
                          previewing
                            ? { key: "flamegraph", content: <FlamegraphFile /> }
                            : { key: "page", content: <ColdStartStage timeline={timeline} /> }
                        }
                      />
                    ),
                  }
                : undefined
            }
            overlay={
              <Cursor
                target={target}
                pressed={pressed}
                rest={{ x: compact ? 660 : 1200, y: 740 }}
              />
            }
          >
            <div className="absolute inset-0 flex">
              <div className="relative flex min-w-0 flex-1 flex-col">
                <PaneHeader
                  left={
                    <div className="flex min-w-0 items-center gap-[6.56px] overflow-hidden whitespace-nowrap [&>*]:shrink-0">
                      <PaneTab icon={<BoardIcon className="size-4" />} label="Board" active />
                      <PaneTab icon={<ListIcon className="size-4" />} label="List" />
                      <span className="flex size-6 items-center justify-center text-app-faint">
                        <PlusIcon className="size-3.5" />
                      </span>
                      <span className="flex size-6 items-center justify-center text-app-faint">
                        <CanvasViewIcon className="size-3.5" />
                      </span>
                    </div>
                  }
                  right={<DatabaseToolbar />}
                />
                <LayoutGroup>
                  <div className="min-h-0 flex-1 overflow-hidden px-2.5 pt-2 pb-3">
                    <div
                      className="flex w-max items-stretch gap-2.5"
                      style={{ transform: compact ? "translateX(-472px)" : undefined }}
                    >
                      {STATUSES.map((status) => {
                        const column = cards.filter((card) => statusOf(card) === status);
                        return (
                          <BoardColumn key={status} status={status} count={column.length}>
                            {column.map((card) => (
                              <BoardCardView
                                key={card.id}
                                card={card}
                                cursorTarget={`card:${card.id}`}
                              />
                            ))}
                          </BoardColumn>
                        );
                      })}
                    </div>
                  </div>
                </LayoutGroup>
                {compact && open ? null : <AgentDock agent={AGENTS.solHigh} />}
              </div>
            </div>
          </AppWindow>
        )}
      </Stage>
    </div>
  );
}

/** Database settings, Filter, Sort, Display options, then Search. */
function DatabaseToolbar() {
  return (
    <div className="flex shrink-0 items-center gap-0.5 text-app-faint">
      {[
        { Icon: DatabaseSettingsIcon, label: "Database settings" },
        { Icon: DatabaseFilterIcon, label: "Filter View" },
        { Icon: DatabaseSortIcon, label: "Sort View" },
        { Icon: DatabaseSettingsIcon, label: "Display options" },
        { Icon: SearchIcon, label: "Search" },
      ].map(({ Icon, label }) => (
        <span key={label} aria-label={label} className="flex size-6 items-center justify-center">
          <Icon className="size-[13px]" />
        </span>
      ))}
    </div>
  );
}

/** The Page an agent is writing into, with the files it attached. */
function ColdStartStage({ timeline }: { readonly timeline: Timeline }) {
  const { reached } = timeline;
  return (
    <PagePanel
      title="Dashboard cold start"
      properties={
        <>
          <TaskProperties
            status="Review"
            chat={{ title: "Dashboard cold start", provider: "opencode" }}
          />
          <FilesProperty
            folders={reached("attach") ? COLD_START_FILES : []}
            open={reached("files")}
            fresh={reached("attach")}
            source={{ chat: "Dashboard cold start", provider: "opencode" }}
            selected={reached("aim:image") ? FLAMEGRAPH.name : null}
          />
        </>
      }
    >
      <p className="px-0.5">{COLD_START_MESSAGE}</p>
      <ColdStartFindings timeline={timeline} startAt={FINDINGS_AT} />
    </PagePanel>
  );
}

/** The flame graph the agent attached, opened from the Page in a file tab beside it. */
function FlamegraphFile() {
  return (
    <FileView
      path={["Dashboard cold start", "profile", FLAMEGRAPH.name]}
      icon={PAGE_FILE_ICON.image}
    >
      <figure className="flex h-full flex-col items-center justify-center gap-3 px-4 pb-6">
        <Flamegraph />
        <figcaption className="text-[11px] text-app-faint">
          Main thread, first 2.3 s · 2400 × 720 · 86 KB
        </figcaption>
      </figure>
    </FileView>
  );
}
