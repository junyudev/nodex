import { AnimatePresence, motion, useTransform } from "motion/react";
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
import { ColdStartReport, FilesProperty, PagePanel, TaskProperties } from "../replica/Page";
import { AppSidebar, type SidebarChat } from "../replica/Sidebar";
import { Stage } from "../replica/Stage";
import { BrowserView } from "../replica/Viewers";
import { CAPTURE_DEMOS } from "./capture-demos";
import { AppWindow, NewTab, PaneHeader, PaneTab, Tab, TabGroupContent } from "../replica/Window";
import {
  BoardIcon,
  GlobeIcon,
  HistoryIcon,
  InboxIcon,
  PageIcon,
  SettingsIcon,
  SubagentGlyphIcon,
} from "../replica/icons";
import { ColdStartFindings } from "./ColdStartFindings";
import { Cursor } from "./Cursor";
import {
  AGENTS,
  COLD_START_FILES,
  COLD_START_FINDINGS,
  INBOX_BURST,
  MODEL_CATALOG,
  PASSKEY_SUBAGENTS,
  WEEKLY_LEFT,
  type AgentChoice,
  type InboxMessage,
} from "./lumen";
import { useTimeline, type Cue, type Timeline } from "./timeline";

/** Newest last: the planned fan-out lands right above the composer, where it reads first. */
const ORDER = ["webhooks", "coldstart", "darkmode", "digest", "changelog", "passkeys"];
const MESSAGES = ORDER.map((id) => INBOX_BURST.find((message) => message.id === id)!);
const PASSKEYS = INBOX_BURST.find((message) => message.id === "passkeys")!;
const COLD_START = INBOX_BURST.find((message) => message.id === "coldstart")!;
const REPORT = COLD_START_FILES[0].files[0];

const TYPE_MS = 13;
const SEND_GAP = 220;
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
  readonly typing: readonly {
    readonly text: string;
    readonly start: number;
    readonly sent: number;
  }[];
  readonly cues: readonly Cue[];
  readonly chapters: readonly Chapter[];
  readonly findingsAt: readonly number[];
  /** When the reader starts typing into the model menu. */
  readonly modelQueryAt: number;
  readonly durationMs: number;
}

function buildSchedule(): Schedule {
  const cues: Cue[] = [];
  const typing: { text: string; start: number; sent: number }[] = [];
  let clock = 700;
  for (const message of MESSAGES) {
    const sent = clock + message.text.length * TYPE_MS + 140;
    typing.push({ text: message.text, start: clock, sent });
    cues.push({ id: `sent:${message.id}`, at: sent });
    clock = sent + SEND_GAP;
  }
  const suggested = clock + 1500;
  cues.push({ id: "suggested", at: suggested });
  // The reader takes the passkey plan's lead off GPT-6.1 Sol and gives it to Claude Opus before
  // starting it: open the model menu, search, pick.
  const menu = suggested + 2600;
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
  // Each decision is aimed at only once the card before it has folded away, so the pointer
  // lands where the next button settles rather than where it was.
  let press = pick + 700;
  for (const message of [...MESSAGES].reverse()) {
    cues.push(
      { id: `aim:${message.id}`, at: press - 560 },
      { id: `press:${message.id}`, at: press },
      { id: `decided:${message.id}`, at: press + 170 },
      { id: `folded:${message.id}`, at: press + 700 },
    );
    press += 1100;
  }
  const clear = press - 250;

  // The cleared Inbox shows how it planned; then every agent: the passkey chat, whose Claude lead
  // the reader points at before opening one of its GPT-6.1 Sol subagents to watch it work in
  // Codex, beside the chat that sent it.
  const chat = clear + 3100;
  const subagent = chat + 3300;
  cues.push(
    { id: "clear", at: clear },
    { id: "aim:chat", at: clear + 2300 },
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
    { id: "sub:test", at: subagent + 2250 },
    // It finishes while the reader watches, and the chat that sent it sees it done.
    { id: "done:0", at: subagent + 2950 },
    { id: "done:1", at: subagent + 3350 },
  );

  // All local: the cold-start chat opens beside its Page; the agent writes its findings into the
  // Page, attaches its report, moves the Page to Review, and the reader opens the report.
  const cold = subagent + 4300;
  const findingsAt = COLD_START_FINDINGS.map((_, index) => cold + 1500 + index * 550);
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
    { id: "aim:files", at: cold + 4900 },
    { id: "press:files", at: cold + 5450 },
    { id: "files", at: cold + 5600 },
    { id: "aim:report", at: cold + 6500 },
    { id: "press:report", at: cold + 7050 },
    { id: "report", at: cold + 7200 },
    { id: "rest", at: cold + 7800 },
  );
  const durationMs = cold + 12400;
  return {
    typing,
    cues,
    findingsAt,
    modelQueryAt,
    durationMs,
    chapters: [
      // The cleared Inbox, with how it plans, closes the first chapter.
      { from: 0, to: clear + 2300, seekTo: 0 },
      { from: clear + 2300, to: cold - 900, seekTo: chat - 120 },
      { from: cold - 900, to: durationMs, seekTo: cold - 120 },
    ],
  };
}

const SCHEDULE = buildSchedule();

/** Presses that open something: each ends at the cue of the same name. */
const OPENING_PRESSES: readonly string[] = ["chat", "subagent", "cold", "files", "report"];

/**
 * The hero story in three chapters, one per headline line. The headline buttons
 * (`[data-hero-chapter]`) jump to a chapter, and the hero element carries the playing chapter
 * and its progress (`data-chapter`, `--hero-progress`) for the headline to show.
 */
export default function HeroDemo({ controls = true }: { readonly controls?: boolean }) {
  const root = useRef<HTMLDivElement | null>(null);
  const timeline = useTimeline(SCHEDULE, root);
  const { reached, elapsed, seek, still } = timeline;

  useEffect(() => {
    const hero = root.current?.closest<HTMLElement>("[data-hero]");
    const headline = hero?.querySelector<HTMLElement>("h1");
    if (!hero || !headline) return;
    const buttons = [...headline.querySelectorAll<HTMLElement>("[data-hero-chapter]")];
    // The headline stays fully lit until the demo plays or a chapter is chosen.
    const sync = (t: number) => {
      const found = SCHEDULE.chapters.findIndex((chapter) => t >= chapter.from && t < chapter.to);
      const index = found === -1 ? SCHEDULE.chapters.length - 1 : found;
      const chapter = SCHEDULE.chapters[index]!;
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
      const chapter = button ? SCHEDULE.chapters[Number(button.dataset.heroChapter)] : undefined;
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
  }, [elapsed, seek, still]);

  const composerText = useTransform(elapsed, (t) => {
    const current = SCHEDULE.typing.find((entry) => t >= entry.start && t < entry.sent);
    if (!current) return "";
    return current.text.slice(0, Math.floor((t - current.start) / TYPE_MS));
  });
  const placeholderOpacity = useTransform(elapsed, (t): number =>
    SCHEDULE.typing.some((entry) => t >= entry.start && t < entry.sent) ? 0 : 1,
  );
  const modelQuery = useTransform(elapsed, (t) =>
    MODEL_QUERY.slice(0, Math.max(0, Math.floor((t - SCHEDULE.modelQueryAt) / QUERY_MS) + 1)),
  );
  const modelQueryPlaceholder = useTransform(elapsed, (t): number =>
    t >= SCHEDULE.modelQueryAt ? 0 : 1,
  );
  const searched = reached("filtered");
  const leadChoice = {
    id: PASSKEYS.id,
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
            actions={<div className="px-2 py-[5px]">Use for all Inbox chats</div>}
          />
        ) : null}
      </AnimatePresence>
    ),
  };

  const visible = MESSAGES.filter(
    (message) => reached(`sent:${message.id}`) && !reached(`folded:${message.id}`),
  );
  // Every message waits for advice from the moment it is sent until the suggestions land.
  const phaseOf = (message: InboxMessage): CardPhase =>
    reached(`decided:${message.id}`) ? "decided" : reached("suggested") ? "suggested" : "waiting";

  const pressing = [...MESSAGES.map((message) => message.id), ...OPENING_PRESSES].find(
    (id) => reached(`press:${id}`) && !reached(OPENING_PRESSES.includes(id) ? id : `decided:${id}`),
  );
  const aiming = [...MESSAGES]
    .reverse()
    .find((message) => reached(`aim:${message.id}`) && !reached(`decided:${message.id}`));
  const cursorTarget = reached("rest")
    ? null
    : reached("aim:report")
      ? "file:report.html"
      : reached("aim:files")
        ? "files"
        : reached("aim:cold") && !reached("cold")
          ? "chat:Dashboard cold start"
          : reached("aim:subagent") && !reached("cold")
            ? "subagent"
            : reached("aim:lead") && !reached("aim:subagent")
              ? "lead"
              : reached("aim:chat") && !reached("chat")
                ? "chat:Passkey sign-in"
                : aiming
                  ? `decision:${aiming.id}`
                  : reached("aim:pick") && !reached("pick")
                    ? "pick"
                    : reached("aim:model") && !reached("pick")
                      ? `model:${PASSKEYS.id}`
                      : null;
  const pressingMenu =
    (reached("press:model") && !reached("menu")) || (reached("press:pick") && !reached("pick"));

  const chats: SidebarChat[] = [
    {
      title: "Settings redesign",
      project: "lumen-web",
      provider: "claude",
      working: reached("folded:darkmode"),
    },
    { title: "Rate limiter", project: "lumen-api", provider: "codex", working: false },
  ];
  for (const message of [...MESSAGES].reverse()) {
    const dispatch = message.dispatch;
    if (dispatch.kind === "new_chat" && reached(`folded:${message.id}`)) {
      chats.push({
        title: dispatch.chat,
        project: dispatch.project,
        provider: dispatch.agent.provider,
        working: message.id === "coldstart" ? !reached("cold:answer") : true,
      });
    }
  }
  const inboxCount = MESSAGES.filter(
    (message) => reached(`sent:${message.id}`) && !reached(`decided:${message.id}`),
  ).length;

  const scene = reached("cold") ? "cold" : reached("chat") ? "passkeys" : "inbox";
  const openChat =
    scene === "cold" ? "Dashboard cold start" : scene === "passkeys" ? "Passkey sign-in" : null;
  const reportOpen = scene === "cold" && reached("report");

  // A chat started from the Inbox opens its Page in the side group. A subagent the reader opens
  // from the chat lands there in the Subagents tab, and a report opened from a Page in a new
  // browser tab.
  const subagentOpen = scene === "passkeys" && reached("subagent");
  const pageGroup =
    scene === "passkeys"
      ? {
          key: subagentOpen ? "subagent" : "passkeys",
          tabs: (
            <>
              <Tab
                icon={<PageIcon className="size-4" />}
                label="Passkey sign-in"
                active={!subagentOpen}
              />
              {subagentOpen ? (
                <NewTab>
                  <Tab icon={<SubagentGlyphIcon className="size-4" />} label="Subagents" active />
                </NewTab>
              ) : null}
            </>
          ),
          content: subagentOpen ? (
            <WebAuthnSubagent timeline={timeline} />
          ) : (
            <PagePanel
              title="Passkey sign-in"
              properties={
                <TaskProperties
                  status="Build"
                  chat={{ title: "Passkey sign-in", provider: "claude" }}
                />
              }
            >
              <p className="px-0.5">{PASSKEYS.text}</p>
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
                  label="Dashboard cold start"
                  active={!reportOpen}
                />
                {reportOpen ? (
                  <NewTab>
                    <Tab icon={<GlobeIcon className="size-4" />} label={REPORT.name} active />
                  </NewTab>
                ) : null}
              </>
            ),
            content: reportOpen ? (
              <BrowserView address={["Dashboard cold start", "profile", REPORT.name]}>
                <div className="absolute inset-0 p-3">
                  <ColdStartReport />
                </div>
              </BrowserView>
            ) : (
              <ColdStartPage timeline={timeline} />
            ),
          }
        : null;
  const chat =
    scene === "passkeys" ? (
      <PasskeyChat
        lead={reached("lead") && !reached("aim:subagent")}
        card={reached("card") && !reached("subagent")}
        secondTool={reached("tool:2")}
        finished={[reached("done:0"), reached("done:1"), false, false]}
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
                    <Tab icon={<InboxIcon className="size-4" />} label="Inbox" active />
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
          {timeline.paused ? "Play demo" : "Pause demo"}
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
  return (
    <div className="absolute inset-0 flex flex-col">
      <PaneHeader
        left={
          <>
            <PaneTab icon={<InboxIcon className="size-4" />} label="Inbox" count={count} active />
            <PaneTab icon={<HistoryIcon className="size-4" />} label="History" />
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
        <div className="relative flex min-h-0 w-full max-w-[640px] flex-1 flex-col justify-end overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_72px)]">
          <AnimatePresence initial={false}>
            {visible.map((message) => (
              <motion.div
                key={message.id}
                layout="position"
                initial={{ opacity: 0, y: 14, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, height: 0, marginTop: 0, transition: { duration: 0.32 } }}
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
  const subagents: Subagent[] = PASSKEY_SUBAGENTS.map((agent, index) => ({
    ...agent,
    status: finished[index] ? "finished" : "working",
  }));
  const dispatch = PASSKEYS.dispatch;
  return (
    <ChatColumn
      agent={AGENTS.opus}
      running
      modelTarget="lead"
      modelPopover={
        <AnimatePresence>{lead ? <LeadCard agent={AGENTS.opus} /> : null}</AnimatePresence>
      }
    >
      <UserBubble>{dispatch.kind === "new_chat" ? dispatch.prompt : PASSKEYS.text}</UserBubble>
      <p className="text-[14px] leading-[21px]">
        I’ll build the sign-in UI and the session flow myself and hand the rest out in parallel:
        three parts to GPT-6.1 Sol, the docs to a free model.
      </p>
      <div className="relative">
        <SubagentLine subagents={subagents} cursorTarget="subagent" />
        <AnimatePresence>
          {card ? (
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="absolute top-full left-6 z-10 mt-1.5"
            >
              <SubagentCard subagent={subagents[0]!} />
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
      <WorkingLine label="Wiring the passkey ceremony into the session" />
    </ChatColumn>
  );
}

/** The first passkey subagent's own conversation: Claude sent it, Codex runs it. */
function WebAuthnSubagent({ timeline }: { readonly timeline: Timeline }) {
  const { reached } = timeline;
  const webauthn = PASSKEY_SUBAGENTS[0];
  const finished = reached("done:0");
  return (
    <SubagentThread
      subagent={webauthn}
      prompt={webauthn.prompt}
      sentBy={{ chat: "Passkey sign-in", agent: AGENTS.opus }}
      running={!finished}
    >
      {finished ? <WorkedFor duration="4m 08s" /> : null}
      <div className="flex flex-col gap-1.5">
        {reached("sub:read") ? <ToolLine row={{ verb: "Read", target: "lib/session.ts" }} /> : null}
        {reached("sub:edit") ? (
          <ToolLine
            row={{ verb: "Edited", target: "app/api/auth/webauthn/register/route.ts", added: 64 }}
          />
        ) : null}
        {reached("sub:edit2") ? (
          <ToolLine
            row={{ verb: "Edited", target: "app/api/auth/webauthn/verify/route.ts", added: 71 }}
          />
        ) : null}
        {reached("sub:test") ? (
          <ToolLine row={{ verb: "Ran", target: "pnpm test webauthn" }} />
        ) : null}
      </div>
      {finished ? (
        <motion.p
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-[14px] leading-[21px]"
        >
          Registration and assertion routes are in, with a challenge store that expires after five
          minutes. 12 tests pass, and password sign-in is untouched.
        </motion.p>
      ) : (
        <WorkingLine label={reached("sub:test") ? "Running the tests" : "Writing the routes"} />
      )}
    </SubagentThread>
  );
}

function ColdStartChat({ timeline }: { readonly timeline: Timeline }) {
  const { reached } = timeline;
  const dispatch = COLD_START.dispatch;
  const page = <PageIcon className="size-3.5" />;
  return (
    <ChatColumn agent={AGENTS.deepseek} running={!reached("cold:answer")}>
      <UserBubble>{dispatch.kind === "new_chat" ? dispatch.prompt : COLD_START.text}</UserBubble>
      {reached("cold:answer") ? <WorkedFor duration="3m 12s" /> : null}
      <div className="flex flex-col gap-1.5">
        <ToolLine row={{ verb: "Ran", target: "pnpm profile:dashboard --cold" }} />
        {reached("cold:report") ? (
          <ToolLine
            row={{ verb: "Ran", target: "node scripts/report.mjs > profile/report.html" }}
          />
        ) : null}
        {reached("cold:write") ? (
          <ToolLine
            row={{ verb: "Wrote", target: "Findings into Dashboard cold start", icon: page }}
          />
        ) : null}
        {reached("cold:attach") ? (
          <ToolLine
            row={{ verb: "Attached", target: "3 files to Dashboard cold start", icon: page }}
          />
        ) : null}
        {reached("cold:review") ? (
          <ToolLine row={{ verb: "Moved", target: "Dashboard cold start to Review", icon: page }} />
        ) : null}
      </div>
      {reached("cold:answer") ? (
        <motion.p
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-[14px] leading-[21px]"
        >
          Cold start is 2.3 s, and 1.1 s of it is hydrating the whole workspace tree before first
          paint. The findings are on the page, with the report, flame graph and raw trace attached.
        </motion.p>
      ) : (
        <WorkingLine label="Profiling the dashboard’s cold start" />
      )}
    </ChatColumn>
  );
}

function ColdStartPage({ timeline }: { readonly timeline: Timeline }) {
  const { reached } = timeline;
  return (
    <PagePanel
      title="Dashboard cold start"
      properties={
        <>
          <TaskProperties
            status={reached("cold:review") ? "Review" : "Build"}
            chat={{ title: "Dashboard cold start", provider: "opencode" }}
          />
          <FilesProperty
            folders={reached("cold:attach") ? COLD_START_FILES : []}
            open={reached("files")}
            fresh={reached("cold:attach")}
            source={{ chat: "Dashboard cold start", provider: "opencode" }}
            selected={reached("aim:report") ? REPORT.name : null}
          />
        </>
      }
    >
      <p className="px-0.5">{COLD_START.text}</p>
      <ColdStartFindings timeline={timeline} startAt={SCHEDULE.findingsAt} />
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
