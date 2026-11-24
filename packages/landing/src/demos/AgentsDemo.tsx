import { AnimatePresence, motion, useTransform } from "motion/react";
import { useMemo, useRef } from "react";
import { useReplicaCopy } from "../replica/copy";
import { DemoLocaleProvider, useDemoLocale, useLumen, type DemoProps } from "./demo-locale";
import { AppWindow, ProviderMark, Tab } from "../replica/Window";
import { ChatComposer, HandoffDivider, UserBubble, WorkedFor, WorkingLine } from "../replica/Chat";
import { ModelMenu } from "../replica/ModelMenu";
import { Stage } from "../replica/Stage";
import { CAPTURE_DEMOS } from "./capture-demos";
import { Cursor } from "./Cursor";
import { byLocale } from "../lib/locale";
import { AGENTS, lumen, MODEL_CATALOG, WEEKLY_LEFT, type ProviderKind } from "./lumen";
import { useTimeline, useTyped, type TimelineScript } from "./timeline";

const SEARCH = "free";
const TYPE_START = 5300;
const TYPE_MS = 110;
const PICK = TYPE_START + SEARCH.length * TYPE_MS + 1300;

/** The follow-up sent on the newly chosen model, which hands it the conversation so far. */
const FOLLOW_UP_AT = PICK + 700;
const FOLLOW_UP_MS = 16;
export const SCRIPTS = byLocale((locale): TimelineScript => {
  const send = FOLLOW_UP_AT + lumen[locale].followUp.length * FOLLOW_UP_MS + 250;
  const cues = [
    { id: "aim:claude", at: 300 },
    { id: "card:claude", at: 800 },
    { id: "aim:codex", at: 2400 },
    { id: "card:codex", at: 2900 },
    { id: "aim:model", at: 4300 },
    { id: "press:model", at: 4750 },
    { id: "menu", at: 4900 },
    { id: "filtered", at: TYPE_START + SEARCH.length * TYPE_MS },
    { id: "aim:pick", at: TYPE_START + SEARCH.length * TYPE_MS + 500 },
    { id: "press:pick", at: TYPE_START + SEARCH.length * TYPE_MS + 1150 },
    { id: "pick", at: PICK },
    { id: "rest", at: PICK + 700 },
    { id: "compose", at: FOLLOW_UP_AT },
    { id: "send", at: send },
    { id: "aim:handoff", at: send + 700 },
    { id: "explain", at: send + 1250 },
    { id: "reply", at: send + 1500 },
    { id: "answer", at: send + 2700 },
    { id: "unexplain", at: send + 3600 },
  ];
  return { cues, durationMs: send + 5900 };
});

/** Every plan's remaining usage on the rail, and every provider's models in one menu. */
export default function AgentsDemo({ locale }: DemoProps) {
  return (
    <DemoLocaleProvider locale={locale}>
      <AgentsPlayback />
    </DemoLocaleProvider>
  );
}

function AgentsPlayback() {
  const story = useLumen();
  const root = useRef<HTMLDivElement | null>(null);
  const timeline = useTimeline(SCRIPTS[useDemoLocale()], root);
  const { reached, elapsed } = timeline;
  const typed = useTransform(elapsed, (t) =>
    SEARCH.slice(
      0,
      Math.max(0, Math.min(SEARCH.length, Math.floor((t - TYPE_START) / TYPE_MS) + 1)),
    ),
  );
  const placeholderOpacity = useTransform(elapsed, (t): number => (t >= TYPE_START ? 0 : 1));
  const followUp = useTyped(elapsed, story.followUp, FOLLOW_UP_AT, FOLLOW_UP_MS);
  const showFree = reached("filtered");
  const models = useMemo(
    () => (showFree ? MODEL_CATALOG.filter((model) => model.free) : MODEL_CATALOG),
    [showFree],
  );
  const card =
    reached("card:codex") && !reached("aim:model")
      ? "codex"
      : reached("card:claude") && !reached("aim:codex")
        ? "claude"
        : null;
  const menuOpen = reached("menu") && !reached("pick");
  const chosen = reached("pick") ? "DeepSeek V4.1 Flash Free" : "Claude Opus 5.5";
  const chosenProvider: ProviderKind = reached("pick") ? "opencode" : "claude";
  const target = reached("unexplain")
    ? null
    : reached("aim:handoff")
      ? "handoff"
      : reached("rest")
        ? null
        : reached("aim:pick")
          ? "pick"
          : reached("aim:model")
            ? "model"
            : reached("aim:codex")
              ? "usage:codex"
              : reached("aim:claude")
                ? "usage:claude"
                : null;
  const pressed =
    (reached("press:model") && !reached("menu")) || (reached("press:pick") && !reached("pick"));

  return (
    <div ref={root} className="w-full">
      <Stage {...CAPTURE_DEMOS.agents}>
        {() => (
          <AppWindow
            key={timeline.loop}
            rail
            usage={{ ...WEEKLY_LEFT, claude: 0.38 }}
            focusedUsage={card}
            tabs={<Tab label={story.titles.coldstart} titleOnly />}
            overlay={
              <>
                <AnimatePresence mode="wait">
                  {card ? <UsageCard key={card} kind={card} /> : null}
                </AnimatePresence>
                <Cursor target={target} pressed={pressed} rest={{ x: 660, y: 560 }} />
              </>
            }
          >
            <div className="absolute inset-0 flex flex-col px-6 pt-6 pb-5">
              <div className="mb-3 flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-hidden text-[14px] leading-[21px] [mask-image:linear-gradient(to_bottom,transparent,black_48px)]">
                <UserBubble>{story.profileRequest}</UserBubble>
                <div className="mt-4">
                  <WorkedFor minutes={2} seconds={12} />
                </div>
                <p>{story.profileSummary}</p>
                {reached("send") ? (
                  <>
                    <HandoffDivider
                      from={AGENTS.opus}
                      to={AGENTS.deepseek}
                      cursorTarget="handoff"
                      explained={reached("explain") && !reached("unexplain")}
                    />
                    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                      <UserBubble>{story.followUp}</UserBubble>
                    </motion.div>
                  </>
                ) : null}
                {reached("answer") ? (
                  <motion.p initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
                    {story.fixPlan}
                  </motion.p>
                ) : reached("reply") ? (
                  <WorkingLine label={story.readingContext} />
                ) : null}
              </div>

              <ChatComposer
                agent={{ provider: chosenProvider, model: chosen, effort: "High" }}
                modelTarget="model"
                input={
                  reached("compose") && !reached("send") ? (
                    <motion.span>{followUp}</motion.span>
                  ) : undefined
                }
                modelPopover={
                  <AnimatePresence>
                    {menuOpen ? (
                      <ModelMenu
                        models={models}
                        listKey={showFree ? "free" : "all"}
                        chosen={chosen}
                        pick={{
                          name: "DeepSeek V4.1 Flash Free",
                          target: "pick",
                          hovered: reached("aim:pick"),
                        }}
                        query={typed}
                        queryPlaceholderOpacity={placeholderOpacity}
                      />
                    ) : null}
                  </AnimatePresence>
                }
              />
            </div>
          </AppWindow>
        )}
      </Stage>
    </div>
  );
}

function UsageCard({ kind }: { readonly kind: "claude" | "codex" }) {
  const story = useLumen();
  const usage = story.usage[kind];
  const copy = useReplicaCopy();
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="absolute bottom-16 left-14 z-10 flex w-76 flex-col rounded-[15px] bg-app-menu/90 text-[13px] leading-[18.5714px] shadow-[0_8px_24px_rgb(0_0_0/0.12)] ring-[0.5px] ring-app-line backdrop-blur-sm [corner-shape:superellipse(1.5)]"
    >
      <div className="flex items-center gap-2.5 py-2.5 pr-2 pl-3">
        <ProviderMark kind={kind} className="size-4" />
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-medium">{usage.title}</span>
          <span className="truncate text-[12px] leading-4 text-app-muted">{usage.plan}</span>
        </div>
      </div>
      <div className="flex flex-col gap-3 border-t border-app-line p-3">
        {usage.windows.map((window) => (
          <div key={window.label} className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-1.5 text-[12px] leading-4 text-app-muted">
              <span className="shrink-0 text-[13px] leading-[18.5714px] font-medium text-app-fg">
                {window.label}
              </span>
              <span className="min-w-0 truncate">{window.reset}</span>
              <span className="ml-auto shrink-0 tabular-nums">
                {copy.budgetPrefix}
                <span className="text-[13px] font-medium text-app-fg">
                  {Math.round(window.left * 100)}%
                </span>
                {copy.budgetSuffix}
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-app-fg/10">
              <motion.div
                className="h-full rounded-full bg-app-fg/55"
                initial={{ width: 0 }}
                animate={{ width: `${window.left * 100}%` }}
                transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-app-line px-3 py-2 text-[12px] leading-4 text-app-muted">
        {story.usageSource}
      </div>
    </motion.div>
  );
}
