import { useRef } from "react";
import { LayoutGroup } from "motion/react";
import { DemoLocaleProvider, useLumen, type DemoProps } from "./demo-locale";
import { useReplicaCopy } from "../replica/copy";
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
import { PageFileView } from "../replica/Viewers";
import { CAPTURE_DEMOS } from "./capture-demos";
import { Cursor } from "./Cursor";
import { ColdStartFindings } from "./ColdStartFindings";
import { AGENTS, COLD_START_FILES, lumen } from "./lumen";
import { useTimeline, type Timeline, type TimelineScript } from "./timeline";

const FLAMEGRAPH = COLD_START_FILES[0].files[1];

const OPEN = 2000;
/** The agent starts writing as soon as the Page opens. */
const FINDINGS_AT = lumen.en.findings.map((_, index) => OPEN + 500 + index * 550);
const ATTACH = FINDINGS_AT.at(-1)! + 900;

export const SCRIPT: TimelineScript = {
  cues: [
    { id: "move", at: 500 },
    { id: "aim:card", at: OPEN - 800 },
    { id: "press:card", at: OPEN - 150 },
    { id: "open", at: OPEN },
    ...FINDINGS_AT.map((at, index) => ({ id: `finding:${index}`, at })),
    { id: "attach", at: ATTACH },
    { id: "aim:image", at: ATTACH + 1200 },
    { id: "press:image", at: ATTACH + 1750 },
    { id: "preview", at: ATTACH + 1900 },
    { id: "rest", at: ATTACH + 2500 },
  ],
  durationMs: ATTACH + 5000,
};

/** The Board moving on its own while agents work, and a Page an agent is writing into. */
export default function PagesDemo({ locale }: DemoProps) {
  return (
    <DemoLocaleProvider locale={locale}>
      <PagesPlayback />
    </DemoLocaleProvider>
  );
}

function PagesPlayback() {
  const story = useLumen();
  const PROJECT_CHATS: readonly SidebarChat[] = [
    { title: story.titles.passkeys, project: "lumen-web", provider: "claude", working: true },
    { title: story.titles.coldstart, project: "lumen-web", provider: "opencode", working: false },
    { title: story.titles.darkmode, project: "lumen-web", provider: "claude", working: false },
  ];

  const copy = useReplicaCopy();
  const root = useRef<HTMLDivElement | null>(null);
  const timeline = useTimeline(SCRIPT, root);
  const { reached } = timeline;
  const statusOf = (card: BoardCard) =>
    card.id === "coldstart" && reached("move") ? "Review" : card.status;
  const cards = story.cards.map((card) =>
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
      : reached("aim:card") && !open
        ? "card:coldstart"
        : null;
  const pressed =
    (reached("press:card") && !open) || (reached("press:image") && !reached("preview"));

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
                <Tab icon={<InboxIcon className="size-4" />} label={copy.inbox} closable={false} />
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
                          label={story.titles.coldstart}
                          active={!previewing}
                        />
                        {previewing ? (
                          <NewTab>
                            <Tab
                              icon={PAGE_FILE_ICON.image}
                              label={FLAMEGRAPH.name}
                              active
                              preview
                            />
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
                      <PaneTab icon={<BoardIcon className="size-4" />} label={copy.board} active />
                      <PaneTab icon={<ListIcon className="size-4" />} label={copy.list} />
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
  const copy = useReplicaCopy();
  return (
    <div className="flex shrink-0 items-center gap-0.5 text-app-faint">
      {[
        { Icon: DatabaseSettingsIcon, label: copy.databaseSettings },
        { Icon: DatabaseFilterIcon, label: copy.filterView },
        { Icon: DatabaseSortIcon, label: copy.sortView },
        { Icon: DatabaseSettingsIcon, label: copy.displayOptions },
        { Icon: SearchIcon, label: copy.search },
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
  const story = useLumen();
  const { reached } = timeline;
  return (
    <PagePanel
      title={story.titles.coldstart}
      properties={
        <>
          <TaskProperties
            status="Review"
            chat={{ title: story.titles.coldstart, provider: "opencode" }}
          />
          <FilesProperty
            folders={reached("attach") ? COLD_START_FILES : []}
            fresh={reached("attach")}
            source={{ chat: story.titles.coldstart, provider: "opencode" }}
            selected={reached("aim:image") ? FLAMEGRAPH.name : null}
            opened={reached("preview") ? [FLAMEGRAPH.name] : []}
          />
        </>
      }
    >
      <p className="px-0.5">{story.inboxById.coldstart.text}</p>
      <ColdStartFindings timeline={timeline} startAt={FINDINGS_AT} />
    </PagePanel>
  );
}

/** The flame graph the agent attached, opened from the Page in a Page File tab beside it. */
function FlamegraphFile() {
  const story = useLumen();
  return (
    <PageFileView page={story.titles.coldstart} path={["profile", FLAMEGRAPH.name]}>
      <figure className="flex h-full flex-col items-center justify-center gap-3 px-4 pb-6">
        <Flamegraph />
        <figcaption className="text-[10px] text-app-faint tabular-nums">
          2400 × 720 · {FLAMEGRAPH.size}
        </figcaption>
      </figure>
    </PageFileView>
  );
}
