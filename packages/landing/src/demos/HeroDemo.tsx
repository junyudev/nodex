import { AnimatePresence, motion, useTransform } from "motion/react";
import { DemoLocaleProvider, useDemoLocale, useLumen, type DemoProps } from "./demo-locale";
import { useReplicaCopy } from "../replica/copy";
import { byLocale } from "../lib/locale";
import { useEffect, useRef, type ReactNode } from "react";
import {
  ChatComposer,
  LeadCard,
  SubagentCard,
  SubagentThread,
  SubagentLine,
  ToolLine,
  UserBubble,
  WorkedFor,
  WorkingLine,
  type Subagent,
} from "../replica/Chat";
import { InboxAllClear, InboxCard, InboxComposer, type CardPhase } from "../replica/Inbox";
import { ModelMenu } from "../replica/ModelMenu";
import {
  ColdStartReport,
  FilesProperty,
  PAGE_FILE_ICON,
  PagePanel,
  TaskProperties,
} from "../replica/Page";
import { AppSidebar, type SidebarChat } from "../replica/Sidebar";
import { Stage } from "../replica/Stage";
import { MapLead, SubagentsOverview, type MapSubagent } from "../replica/Subagents";
import { PageFileView } from "../replica/Viewers";
import { CAPTURE_DEMOS } from "./capture-demos";
import { AppWindow, NewTab, PaneHeader, PaneTab, Tab, TabGroupContent } from "../replica/Window";
import {
  BoardIcon,
  HistoryIcon,
  InboxIcon,
  PageIcon,
  SettingsIcon,
  SubagentGlyphIcon,
} from "../replica/icons";
import { ColdStartFindings } from "./ColdStartFindings";
import { Cursor } from "./Cursor";
import { buildInboxBurstTimeline, composerTextAt, composingAt } from "./inbox-burst-timeline";
import { buildInboxDecisionTimeline, INBOX_CARD_EXIT_MS } from "./inbox-decision-timeline";
import {
  AGENTS,
  COLD_START_FILES,
  lumen,
  MODEL_CATALOG,
  WEEKLY_LEFT,
  type AgentChoice,
  type InboxMessage,
} from "./lumen";
import { useTimeline, type Cue, type Timeline } from "./timeline";

const REPORT = COLD_START_FILES[0].files[0];

/** The passkey subagent the reader opens: Gemini, writing the sign-in tests. */
const TESTS = 1;

/** What the reader types into the model menu, and the lead the Inbox first suggested. */
const MODEL_QUERY = "opus";
const QUERY_MS = 90;
const SUGGESTED_LEAD = AGENTS.sol;

/** A chapter of the hero story; each one is a line of the headline above the demo. */
export interface Chapter {
  readonly from: number;
  readonly to: number;
  /** Where choosing the chapter starts playing: its first scene, not the transition into it. */
  readonly seekTo: number;
}

interface Schedule {
  readonly cues: readonly Cue[];
  readonly burst: ReturnType<typeof buildInboxBurstTimeline>;
  readonly chapters: readonly Chapter[];
  readonly findingsAt: readonly number[];
  /** When the reader starts typing into the model menu. */
  readonly modelQueryAt: number;
  readonly durationMs: number;
}

export const SCRIPTS = byLocale((locale): Schedule => {
  const { inbox, findings } = lumen[locale];
  // The first keystroke lands a beat after the demo appears.
  const burst = buildInboxBurstTimeline(inbox, 200);
  const cues: Cue[] = [...burst.cues];
  // Once the passkey fan-out has landed and been read, the reader takes its lead off GPT-6.2 Sol
  // and gives it to Claude Opus before starting it: open the model menu, search, pick.
  const menu = burst.plannedAt + 1900;
  const modelQueryAt = menu + 300;
  const filtered = modelQueryAt + MODEL_QUERY.length * QUERY_MS;
  const pick = filtered + 650;
  cues.push(
    { id: "aim:model", at: menu - 620 },
    { id: "press:model", at: menu - 120 },
    { id: "menu", at: menu },
    { id: "filtered", at: filtered },
    { id: "aim:pick", at: filtered + 120 },
    { id: "press:pick", at: pick - 130 },
    { id: "pick", at: pick },
  );
  const decisions = buildInboxDecisionTimeline(
    [...inbox].reverse().map((message) => message.id),
    pick + 180,
  );
  cues.push(...decisions.cues);
  const clear = decisions.clearAt;

  // The cleared Inbox shows how it planned; then every agent: the passkey chat, whose Claude lead
  // the reader points at before opening its Gemini subagent to watch it finish in Antigravity,
  // beside the chat that sent it, then stepping back to the chat's whole Subagents map.
  const chat = clear + 2500;
  const subagent = chat + 3300;
  const map = subagent + 3500;
  cues.push(
    { id: "clear", at: clear },
    { id: "aim:chat", at: chat - 700 },
    { id: "press:chat", at: chat - 150 },
    { id: "chat", at: chat },
    { id: "aim:lead", at: chat + 700 },
    { id: "lead", at: chat + 1000 },
    { id: "aim:subagent", at: chat + 1900 },
    { id: "card", at: chat + 2300 },
    { id: "tool:2", at: chat + 2600 },
    { id: "press:subagent", at: subagent - 150 },
    { id: "subagent", at: subagent },
    { id: "sub:read", at: subagent + 450 },
    { id: "sub:edit", at: subagent + 1050 },
    { id: "sub:edit2", at: subagent + 1650 },
    { id: "done:docs", at: subagent + 1300 },
    { id: "sub:test", at: subagent + 1800 },
    // It finishes while the reader watches, and the chat that sent it sees it done.
    { id: "done:tests", at: subagent + 2450 },
    { id: "aim:back", at: subagent + 2950 },
    { id: "press:back", at: map - 150 },
    { id: "back", at: map },
    // The last part comes home while the map is in view.
    { id: "done:webauthn", at: map + 1200 },
  );

  // All local: the cold-start chat opens beside its Page; the agent writes its findings into the
  // Page, attaches its report, moves the Page to Review, and the reader opens the report.
  const cold = map + 2400;
  const findingsAt = findings.map((_, index) => cold + 1500 + index * 550);
  cues.push(
    { id: "aim:cold", at: cold - 700 },
    { id: "press:cold", at: cold - 150 },
    { id: "cold", at: cold },
    { id: "cold:report", at: cold + 700 },
    { id: "cold:write", at: cold + 1400 },
    ...findingsAt.map((at, index) => ({ id: `finding:${index}`, at })),
    { id: "cold:attach", at: cold + 3200 },
    { id: "cold:review", at: cold + 3600 },
    { id: "cold:answer", at: cold + 4100 },
    { id: "aim:report", at: cold + 5600 },
    { id: "press:report", at: cold + 6150 },
    { id: "report", at: cold + 6300 },
    { id: "rest", at: cold + 6900 },
  );
  // The opened report holds just long enough to register before the story plays again.
  const durationMs = cold + 9400;
  return {
    cues,
    burst,
    findingsAt,
    modelQueryAt,
    durationMs,
    chapters: [
      // The cleared Inbox, with how it plans, closes the first chapter.
      { from: 0, to: chat - 700, seekTo: 0 },
      { from: chat - 700, to: cold - 900, seekTo: chat - 120 },
      { from: cold - 900, to: durationMs, seekTo: cold - 120 },
    ],
  };
});

/** Presses that open something: each ends at the cue of the same name. */
const OPENING_PRESSES: readonly string[] = ["chat", "subagent", "back", "cold", "report"];

/**
 * The hero story in three chapters, one per headline line. The headline buttons
 * (`[data-hero-chapter]`) jump to a chapter, and the hero element carries the playing chapter
 * and its progress (`data-chapter`, `--hero-progress`) for the headline to show.
 */
export default function HeroDemo({
  locale,
  controls = true,
}: DemoProps & { readonly controls?: boolean }) {
  return (
    <DemoLocaleProvider locale={locale}>
      <HeroPlayback controls={controls} />
    </DemoLocaleProvider>
  );
}

function HeroPlayback({ controls }: { readonly controls: boolean }) {
  const script = SCRIPTS[useDemoLocale()];
  const story = useLumen();
  const copy = useReplicaCopy();
  const root = useRef<HTMLDivElement | null>(null);
  const timeline = useTimeline(script, root);
  const { reached, elapsed, seek, still } = timeline;

  useEffect(() => {
    const hero = root.current?.closest<HTMLElement>("[data-hero]");
    const headline = hero?.querySelector<HTMLElement>("h1");
    if (!hero || !headline) return;
    const buttons = [...headline.querySelectorAll<HTMLElement>("[data-hero-chapter]")];
    // The headline stays fully lit until the demo plays or a chapter is chosen.
    const sync = (t: number) => {
      const found = script.chapters.findIndex((chapter) => t >= chapter.from && t < chapter.to);
      const index = found === -1 ? script.chapters.length - 1 : found;
      const chapter = script.chapters[index]!;
      const progress = Math.min(1, Math.max(0, (t - chapter.from) / (chapter.to - chapter.from)));
      if (hero.dataset.chapter !== String(index)) {
        hero.dataset.chapter = String(index);
        buttons.forEach((button, at) =>
          at === index
            ? button.setAttribute("aria-current", "step")
            : button.removeAttribute("aria-current"),
        );
      }
      // Only the headline reads the progress, so only its small subtree restyles each frame.
      headline.style.setProperty("--hero-progress", progress.toFixed(4));
    };
    const choose = (event: MouseEvent) => {
      const button = (event.target as Element | null)?.closest<HTMLElement>("[data-hero-chapter]");
      const chapter = button ? script.chapters[Number(button.dataset.heroChapter)] : undefined;
      if (!chapter) return;
      // Under reduced motion a chapter is shown by its finished frame.
      seek(still ? chapter.to - 1 : chapter.seekTo);
      const demo = root.current?.getBoundingClientRect();
      if (demo && (demo.top > window.innerHeight * 0.7 || demo.bottom < 0)) {
        root.current?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
      }
    };
    if (still) sync(elapsed.get());
    const stop = elapsed.on("change", sync);
    headline.addEventListener("click", choose);
    return () => {
      stop();
      headline.removeEventListener("click", choose);
    };
  }, [elapsed, script, seek, still]);

  const composerText = useTransform(elapsed, (t) => composerTextAt(script.burst, t));
  const placeholderOpacity = useTransform(elapsed, (t): number =>
    composingAt(script.burst, t) ? 0 : 1,
  );
  const modelQuery = useTransform(elapsed, (t) =>
    MODEL_QUERY.slice(0, Math.max(0, Math.floor((t - script.modelQueryAt) / QUERY_MS) + 1)),
  );
  const modelQueryPlaceholder = useTransform(elapsed, (t): number =>
    t >= script.modelQueryAt ? 0 : 1,
  );
  const searched = reached("filtered");
  const leadChoice = {
    id: story.inboxById.passkeys.id,
    agent: reached("pick") ? undefined : SUGGESTED_LEAD,
    menu: (
      <AnimatePresence>
        {reached("menu") && !reached("pick") ? (
          <ModelMenu
            models={
              searched
                ? MODEL_CATALOG.filter((model) => model.name.includes("Opus"))
                : MODEL_CATALOG
            }
            listKey={searched ? "opus" : "all"}
            chosen={SUGGESTED_LEAD.model}
            pick={{ name: "Claude Opus 5.5", target: "pick", hovered: reached("aim:pick") }}
            query={modelQuery}
            queryPlaceholderOpacity={modelQueryPlaceholder}
            listHeight={168}
            actions={<div className="px-2 py-[5px]">{copy.allInboxChats}</div>}
          />
        ) : null}
      </AnimatePresence>
    ),
  };

  const visible = story.inbox.filter(
    (message) => reached(`sent:${message.id}`) && !reached(`folded:${message.id}`),
  );
  // Each message waits for advice from the moment it is sent until its own plan lands.
  const phaseOf = (message: InboxMessage): CardPhase =>
    reached(`decided:${message.id}`)
      ? "decided"
      : reached(`planned:${message.id}`)
        ? "suggested"
        : "waiting";

  const pressing = [...story.inbox.map((message) => message.id), ...OPENING_PRESSES].find(
    (id) => reached(`press:${id}`) && !reached(OPENING_PRESSES.includes(id) ? id : `decided:${id}`),
  );
  const aiming = [...story.inbox]
    .reverse()
    .find((message) => reached(`aim:${message.id}`) && !reached(`decided:${message.id}`));
  const cursorTarget = reached("rest")
    ? null
    : reached("aim:report")
      ? "file:report.html"
      : reached("aim:cold") && !reached("cold")
        ? "chat:coldstart"
        : reached("cold")
          ? null
          : reached("back")
            ? "map:webauthn"
            : reached("aim:back")
              ? "subagent:back"
              : reached("aim:subagent")
                ? "subagent"
                : reached("aim:lead")
                  ? "lead"
                  : reached("aim:chat") && !reached("chat")
                    ? "chat:passkeys"
                    : aiming
                      ? `decision:${aiming.id}`
                      : reached("aim:pick") && !reached("pick")
                        ? "pick"
                        : reached("aim:model") && !reached("pick")
                          ? `model:${story.inboxById.passkeys.id}`
                          : null;
  const pressingMenu =
    (reached("press:model") && !reached("menu")) || (reached("press:pick") && !reached("pick"));

  const chats: SidebarChat[] = [
    {
      title: story.titles.darkmode,
      project: "lumen-web",
      provider: "antigravity",
      working: reached("folded:darkmode"),
    },
    { title: story.titles.ratelimit, project: "lumen-api", provider: "codex", working: false },
  ];
  for (const message of [...story.inbox].reverse()) {
    const dispatch = message.dispatch;
    if (dispatch.kind === "new_chat" && reached(`folded:${message.id}`)) {
      chats.push({
        title: dispatch.chat,
        cursorTarget: `chat:${message.id}`,
        project: dispatch.project,
        provider: dispatch.agent.provider,
        working: message.id === "coldstart" ? !reached("cold:answer") : true,
      });
    }
  }
  const inboxCount = story.inbox.filter(
    (message) => reached(`sent:${message.id}`) && !reached(`decided:${message.id}`),
  ).length;

  const scene = reached("cold") ? "cold" : reached("chat") ? "passkeys" : "inbox";
  const openChat =
    scene === "cold" ? story.titles.coldstart : scene === "passkeys" ? story.titles.passkeys : null;
  const reportOpen = scene === "cold" && reached("report");

  // A chat started from the Inbox opens its Page in the side group. A subagent the reader opens
  // from the chat lands there in the Subagents tab, whose back arrow steps out to the chat's whole
  // map; a report opened from a Page becomes a preview tab after it.
  const subagentOpen = scene === "passkeys" && reached("subagent");
  const mapOpen = subagentOpen && reached("back");
  const passkeyParts = passkeySubagents(story, copy, timeline);
  const pageGroup =
    scene === "passkeys"
      ? {
          key: mapOpen ? "map" : subagentOpen ? "subagent" : "passkeys",
          tabs: (
            <>
              <Tab
                icon={<PageIcon className="size-4" />}
                label={story.titles.passkeys}
                active={!subagentOpen}
              />
              {subagentOpen ? (
                <NewTab>
                  <Tab
                    icon={<SubagentGlyphIcon className="size-4" />}
                    label={copy.subagents}
                    active
                  />
                </NewTab>
              ) : null}
            </>
          ),
          content: mapOpen ? (
            <SubagentsOverview
              still={still}
              lead={
                <MapLead
                  agent={AGENTS.opus}
                  title={story.titles.passkeys}
                  summary={copy.delegatingBack(
                    passkeyParts.filter((part) => part.edge === "returned").length,
                    passkeyParts.length,
                  )}
                />
              }
              subagents={passkeyParts}
            />
          ) : subagentOpen ? (
            <TestsSubagent timeline={timeline} />
          ) : (
            <PagePanel
              title={story.titles.passkeys}
              properties={
                <TaskProperties
                  status="Doing"
                  turn={{ kind: "working", provider: "claude" }}
                  chat={{ title: story.titles.passkeys, working: true }}
                />
              }
            >
              <p className="px-0.5">{story.inboxById.passkeys.text}</p>
            </PagePanel>
          ),
        }
      : scene === "cold"
        ? {
            key: reportOpen ? "report" : "cold",
            tabs: (
              <>
                <Tab
                  icon={<PageIcon className="size-4" />}
                  label={story.titles.coldstart}
                  active={!reportOpen}
                />
                {reportOpen ? (
                  <NewTab>
                    <Tab icon={PAGE_FILE_ICON.html} label={REPORT.name} active preview />
                  </NewTab>
                ) : null}
              </>
            ),
            content: reportOpen ? (
              // In a side group this narrow, the app folds the path's folders away to keep its controls.
              <PageFileView page={story.titles.coldstart} path={[REPORT.name]} html>
                <div className="absolute inset-0 p-3">
                  <ColdStartReport />
                </div>
              </PageFileView>
            ) : (
              <ColdStartPage timeline={timeline} findingsAt={script.findingsAt} />
            ),
          }
        : null;
  const chat =
    scene === "passkeys" ? (
      <PasskeyChat
        lead={reached("lead") && !reached("aim:subagent")}
        card={reached("card") && !reached("subagent")}
        secondTool={reached("tool:2")}
        finished={passkeyParts.map((part) => part.edge === "returned")}
      />
    ) : scene === "cold" ? (
      <ColdStartChat timeline={timeline} />
    ) : null;

  return (
    <div ref={root} className="flex w-full flex-col">
      <Stage {...CAPTURE_DEMOS.hero} compactWidth={480} compactHeight={680} compactBelow={900}>
        {({ compact }) => {
          // On a narrow screen one group fits: the chat, until the reader opens something in
          // its side group.
          const pageOnly = compact && (scene === "cold" || subagentOpen);
          const main =
            scene === "inbox" ? (
              <InboxStream
                visible={visible}
                phaseOf={phaseOf}
                pressing={pressing}
                leadChoice={leadChoice}
                clear={reached("clear")}
                count={inboxCount}
                composer={
                  <InboxComposer text={composerText} placeholderOpacity={placeholderOpacity} />
                }
              />
            ) : pageOnly ? (
              <TabGroupContent group={pageGroup!} />
            ) : (
              chat
            );
          return (
            <AppWindow
              key={timeline.loop}
              sidebar={
                compact ? undefined : (
                  <AppSidebar
                    chats={chats}
                    inboxCount={inboxCount}
                    selection={openChat ? { kind: "chat", title: openChat } : { kind: "inbox" }}
                  />
                )
              }
              tabs={
                pageOnly ? (
                  pageGroup!.tabs
                ) : openChat ? (
                  <Tab label={openChat} titleOnly />
                ) : (
                  <>
                    <Tab
                      icon={<InboxIcon className="size-4" />}
                      label={copy.inbox}
                      closable={false}
                      active
                    />
                    <Tab icon={<BoardIcon className="size-4" />} label="lumen-web" />
                  </>
                )
              }
              side={
                pageGroup && !compact
                  ? {
                      tabs: pageGroup.tabs,
                      width: 430,
                      children: <TabGroupContent group={pageGroup} />,
                    }
                  : undefined
              }
              overlay={
                <Cursor
                  target={cursorTarget}
                  pressed={pressing !== undefined || pressingMenu}
                  hold={scene === "inbox" && reached("pick") && !reached("clear")}
                  bottomAnchor={aiming ? "inbox-actions" : undefined}
                  rest={{ x: compact ? 620 : 1220, y: 760 }}
                />
              }
            >
              <AnimatePresence initial={false} mode="popLayout">
                <motion.div
                  key={scene}
                  initial={scene === "inbox" ? false : { opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -24, transition: { duration: 0.3 } }}
                  transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}
                  className="absolute inset-0"
                >
                  {main}
                </motion.div>
              </AnimatePresence>
            </AppWindow>
          );
        }}
      </Stage>
      {controls && !still ? (
        <button
          type="button"
          onClick={timeline.toggle}
          className="mt-4 ml-auto flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-1 text-[12px] text-ink-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-3"
        >
          <svg viewBox="0 0 12 12" className="size-3" fill="currentColor" aria-hidden="true">
            {timeline.paused ? (
              <path d="M3 1.8v8.4c0 .5.5.8.9.5l6.6-4.2c.4-.2.4-.8 0-1L3.9 1.3c-.4-.3-.9 0-.9.5Z" />
            ) : (
              <path d="M3 2h2v8H3zM7 2h2v8H7z" />
            )}
          </svg>
          {timeline.paused ? copy.playDemo : copy.pauseDemo}
        </button>
      ) : null}
    </div>
  );
}

function InboxStream({
  visible,
  phaseOf,
  pressing,
  leadChoice,
  clear,
  count,
  composer,
}: {
  readonly visible: readonly InboxMessage[];
  readonly phaseOf: (message: InboxMessage) => CardPhase;
  readonly pressing: string | undefined;
  /** The one card whose model the reader changes, with its menu. */
  readonly leadChoice: {
    readonly id: string;
    readonly agent: AgentChoice | undefined;
    readonly menu: ReactNode;
  };
  readonly clear: boolean;
  readonly count: number;
  readonly composer: ReactNode;
}) {
  const copy = useReplicaCopy();
  return (
    <div className="absolute inset-0 flex flex-col">
      <PaneHeader
        left={
          <>
            <PaneTab
              icon={<InboxIcon className="size-4" />}
              label={copy.inbox}
              count={count}
              active
            />
            <PaneTab icon={<HistoryIcon className="size-4" />} label={copy.history} />
          </>
        }
        right={
          <>
            <BoardIcon className="size-4" />
            <SettingsIcon className="size-4" />
          </>
        }
      />
      <div className="relative flex min-h-0 flex-1 flex-col items-center px-6 pb-5">
        <div
          data-cursor-anchor="inbox-actions"
          className="relative flex min-h-0 w-full max-w-[640px] flex-1 flex-col justify-end overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_72px)]"
        >
          <AnimatePresence initial={false}>
            {visible.map((message) => (
              <motion.div
                key={message.id}
                layout="position"
                initial={{ opacity: 0, y: 14, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{
                  opacity: 0,
                  height: 0,
                  marginTop: 0,
                  transition: { duration: INBOX_CARD_EXIT_MS / 1000 },
                }}
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
                className="mt-4 shrink-0"
              >
                <InboxCard
                  message={message}
                  phase={phaseOf(message)}
                  pressed={pressing === message.id}
                  {...(message.id === leadChoice.id
                    ? { agent: leadChoice.agent, modelMenu: leadChoice.menu }
                    : {})}
                />
              </motion.div>
            ))}
          </AnimatePresence>
          <AnimatePresence>
            {clear ? <InboxAllClear usage={WEEKLY_LEFT} suggestedBy={AGENTS.solHigh} /> : null}
          </AnimatePresence>
        </div>
        <div className="mt-3 w-full max-w-[640px]">{composer}</div>
      </div>
    </div>
  );
}

/** The passkey chat's subagents as its map draws them, and how each stands at this point. */
function passkeySubagents(
  story: ReturnType<typeof useLumen>,
  copy: ReturnType<typeof useReplicaCopy>,
  timeline: Timeline,
): MapSubagent[] {
  return story.subagents.map((subagent, index) => {
    const back = timeline.reached(`done:${subagent.id}`);
    return {
      id: subagent.id,
      name: subagent.name,
      avatar: subagent.avatar,
      agent: subagent.agent,
      edge: back ? "returned" : "flowing",
      status: back ? copy.done : copy.elapsedMinutes([6, 4, 3][index]!),
      tone: back ? "settled" : "plain",
      diff: subagent.diff,
      cursorTarget: `map:${subagent.id}`,
    };
  });
}

function PasskeyChat({
  lead,
  card,
  secondTool,
  finished,
}: {
  /** The reader points at the model button: the Claude lead behind every subagent. */
  readonly lead: boolean;
  readonly card: boolean;
  readonly secondTool: boolean;
  readonly finished: readonly boolean[];
}) {
  const story = useLumen();
  const subagents: Subagent[] = story.subagents.map((agent, index) => ({
    ...agent,
    status: finished[index] ? "finished" : "working",
  }));
  const dispatch = story.inboxById.passkeys.dispatch;
  return (
    <ChatColumn
      agent={AGENTS.opus}
      running
      modelTarget="lead"
      modelPopover={
        <AnimatePresence>{lead ? <LeadCard agent={AGENTS.opus} /> : null}</AnimatePresence>
      }
    >
      {/* The chat receives the confirmed prompt with each checked addition as its own paragraph. */}
      <UserBubble>
        {dispatch.kind === "new_chat" ? (
          <span className="flex flex-col gap-1.5">
            <span>{dispatch.prompt}</span>
            {dispatch.additions?.map((addition) => (
              <span key={addition}>{addition}</span>
            ))}
          </span>
        ) : (
          story.inboxById.passkeys.text
        )}
      </UserBubble>
      <p className="text-[14px] leading-[21px]">{story.passkeyIntro}</p>
      <div className="relative">
        <SubagentLine subagents={subagents} cursorTarget="subagent" targetIndex={TESTS} />
        <AnimatePresence>
          {card ? (
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="absolute top-full left-6 z-10 mt-1.5"
            >
              <SubagentCard subagent={subagents[TESTS]!} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      <div className="flex flex-col gap-1.5">
        <ToolLine
          row={{ verb: "Edited", target: "app/(auth)/sign-in/passkey-button.tsx", added: 86 }}
        />
        {secondTool ? (
          <ToolLine row={{ verb: "Edited", target: "lib/session.ts", added: 31, removed: 12 }} />
        ) : null}
      </div>
      <WorkingLine label={story.wiringPasskeys} />
    </ChatColumn>
  );
}

/** The passkey tests subagent's own conversation: Claude sent it, Gemini runs it in Antigravity. */
function TestsSubagent({ timeline }: { readonly timeline: Timeline }) {
  const story = useLumen();
  const { reached } = timeline;
  const tests = story.subagents[TESTS];
  const finished = reached("done:tests");
  return (
    <SubagentThread
      subagent={tests}
      prompt={tests.prompt}
      sentBy={{ chat: story.titles.passkeys, agent: AGENTS.opus }}
      running={!finished}
      backTarget="subagent:back"
    >
      {finished ? <WorkedFor minutes={3} seconds={41} /> : null}
      <div className="flex flex-col gap-1.5">
        {reached("sub:read") ? (
          <ToolLine row={{ verb: "Read", target: "e2e/sign-in.spec.ts" }} />
        ) : null}
        {reached("sub:edit") ? (
          <ToolLine row={{ verb: "Edited", target: "e2e/passkey-sign-in.spec.ts", added: 164 }} />
        ) : null}
        {reached("sub:edit2") ? (
          <ToolLine row={{ verb: "Edited", target: "e2e/password-fallback.spec.ts", added: 134 }} />
        ) : null}
        {reached("sub:test") ? (
          <ToolLine row={{ verb: "Ran", target: "pnpm test:e2e sign-in" }} />
        ) : null}
      </div>
      {finished ? (
        <motion.p
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-[14px] leading-[21px]"
        >
          {story.testsDone}
        </motion.p>
      ) : (
        <WorkingLine label={reached("sub:test") ? story.testingRoutes : story.writingTests} />
      )}
    </SubagentThread>
  );
}

function ColdStartChat({ timeline }: { readonly timeline: Timeline }) {
  const story = useLumen();
  const { reached } = timeline;
  const dispatch = story.inboxById.coldstart.dispatch;
  const page = <PageIcon className="size-3.5" />;
  return (
    <ChatColumn agent={AGENTS.neon} running={!reached("cold:answer")}>
      <UserBubble>
        {dispatch.kind === "new_chat" ? dispatch.prompt : story.inboxById.coldstart.text}
      </UserBubble>
      {reached("cold:answer") ? <WorkedFor minutes={3} seconds={12} /> : null}
      <div className="flex flex-col gap-1.5">
        <ToolLine row={{ verb: "Ran", target: "pnpm profile:dashboard --cold" }} />
        {reached("cold:report") ? (
          <ToolLine
            row={{ verb: "Ran", target: "node scripts/report.mjs > profile/report.html" }}
          />
        ) : null}
        {reached("cold:write") ? (
          <ToolLine row={{ verb: "Wrote", target: story.wroteFindings, icon: page }} />
        ) : null}
        {reached("cold:attach") ? (
          <ToolLine row={{ verb: "Attached", target: story.attachedReport, icon: page }} />
        ) : null}
        {reached("cold:review") ? (
          <ToolLine row={{ verb: "Marked", target: story.markedColdStart, icon: page }} />
        ) : null}
      </div>
      {reached("cold:answer") ? (
        <motion.p
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-[14px] leading-[21px]"
        >
          {story.coldStartAnswer}
        </motion.p>
      ) : (
        <WorkingLine label={story.profilingColdStart} />
      )}
    </ChatColumn>
  );
}

function ColdStartPage({
  timeline,
  findingsAt,
}: {
  readonly timeline: Timeline;
  readonly findingsAt: readonly number[];
}) {
  const story = useLumen();
  const { reached } = timeline;
  return (
    <PagePanel
      title={story.titles.coldstart}
      properties={
        <>
          <TaskProperties
            status={reached("cold:review") ? "Review" : "Doing"}
            turn={
              reached("cold:answer")
                ? { kind: "review" }
                : { kind: "working", provider: "antigravity" }
            }
            chat={{ title: story.titles.coldstart, working: !reached("cold:answer") }}
          />
          <FilesProperty
            folders={reached("cold:attach") ? COLD_START_FILES : []}
            fresh={reached("cold:attach")}
            source={{ chat: story.titles.coldstart }}
            selected={reached("aim:report") ? REPORT.name : null}
            opened={reached("report") ? [REPORT.name] : []}
          />
        </>
      }
    >
      <p className="px-0.5">{story.inboxById.coldstart.text}</p>
      <ColdStartFindings timeline={timeline} startAt={findingsAt} />
    </PagePanel>
  );
}

function ChatColumn({
  agent,
  running,
  modelTarget,
  modelPopover,
  children,
}: {
  readonly agent: AgentChoice;
  readonly running: boolean;
  readonly modelTarget?: string;
  readonly modelPopover?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center px-6 pb-5">
      <div className="flex min-h-0 w-full max-w-[640px] flex-1 flex-col gap-4 pt-4">{children}</div>
      <div className="mt-3 w-full max-w-[640px]">
        <ChatComposer
          agent={agent}
          running={running}
          modelTarget={modelTarget}
          modelPopover={modelPopover}
        />
      </div>
    </div>
  );
}
