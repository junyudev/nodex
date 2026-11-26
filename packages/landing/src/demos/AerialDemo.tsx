import { motion, useTransform, type MotionValue } from "motion/react";
import { useRef } from "react";
import { AerialView, type AerialChat, type AerialRecent } from "../replica/Aerial";
import { useReplicaCopy } from "../replica/copy";
import { AppSidebar, type SidebarChat } from "../replica/Sidebar";
import { Stage } from "../replica/Stage";
import type { MapSubagent } from "../replica/Subagents";
import { AppWindow, Tab } from "../replica/Window";
import { AgentQuestionIcon, InboxIcon, SpinnerIcon } from "../replica/icons";
import { CAPTURE_DEMOS } from "./capture-demos";
import { DemoLocaleProvider, useLumen, type DemoProps } from "./demo-locale";
import { AGENTS } from "./lumen";
import { useTimeline, type TimelineScript } from "./timeline";

/** A time-lapse: each real second and a bit stands for a minute of work. */
const MINUTE_MS = 1100;

export const SCRIPT: TimelineScript = {
  cues: [
    { id: "back:docs", at: 700 },
    { id: "back:shots", at: 1800 },
    { id: "back:audit", at: 2900 },
    { id: "ask:settings", at: 3600 },
    { id: "back:review", at: 4700 },
    { id: "end:webhooks", at: 5900 },
    { id: "back:webauthn", at: 7100 },
    { id: "back:tests", at: 8300 },
  ],
  durationMs: 10500,
};

/**
 * Every chat at work from above: a Claude lead with Codex, Antigravity and OpenCode subagents, a
 * Codex lead that asks Claude to review, and an Antigravity lead whose Codex subagent delegates
 * again, each line in its harness's color as the results come home.
 */
export default function AerialDemo({ locale }: DemoProps) {
  return (
    <DemoLocaleProvider locale={locale}>
      <AerialPlayback />
    </DemoLocaleProvider>
  );
}

function AerialPlayback() {
  const story = useLumen();
  const copy = useReplicaCopy();
  const root = useRef<HTMLDivElement | null>(null);
  const timeline = useTimeline(SCRIPT, root);
  const { reached, elapsed, still } = timeline;
  const clock = (startMinutes: number) => <Clock elapsed={elapsed} start={startMinutes} />;

  const back = (id: string) => reached(`back:${id}`);
  const subagentState = (id: string, startMinutes: number, diff?: MapSubagent["diff"]) =>
    back(id)
      ? { edge: "returned" as const, status: copy.done, tone: "settled" as const, diff }
      : { edge: "flowing" as const, status: clock(startMinutes), diff };

  const passkeys = story.subagents.map((subagent, index): MapSubagent => ({
    id: subagent.id,
    name: subagent.name,
    avatar: subagent.avatar,
    agent: subagent.agent,
    ...subagentState(subagent.id, [9, 7, 6][index]!, subagent.diff),
  }));
  const passkeysBack = passkeys.filter((subagent) => subagent.edge === "returned").length;

  const { webhooks, settings } = story.aerial;
  const asking = reached("ask:settings");
  const settingsTree: MapSubagent[] = [
    { ...settings.audit, ...subagentState("audit", 5, settings.audit.diff) },
    { ...settings.shots, ...subagentState("shots", 3) },
  ];

  const active: AerialChat[] = [
    {
      id: "passkeys",
      project: "lumen-web",
      pageKey: story.inboxById.passkeys.key,
      agent: AGENTS.opus,
      title: story.titles.passkeys,
      status: clock(14),
      line: story.wiringPasskeys,
      back: copy.backShort(passkeysBack, passkeys.length),
      subagents: passkeys,
    },
    ...(reached("end:webhooks")
      ? []
      : [
          {
            id: "webhooks",
            project: "lumen-api",
            pageKey: story.inboxById.webhooks.key,
            agent: AGENTS.sol,
            title: story.titles.webhooks,
            status: clock(11),
            line: webhooks.line,
            back: copy.backShort(back("review") ? 1 : 0, 1),
            subagents: [
              { ...webhooks.review, ...subagentState("review", 4, webhooks.review.diff) },
            ],
          } satisfies AerialChat,
        ]),
    {
      id: "settings",
      project: "lumen-web",
      pageKey: story.inboxById.darkmode.key,
      agent: AGENTS.neon,
      title: story.titles.darkmode,
      status: asking ? copy.needsYourAnswer : clock(8),
      tone: asking ? "attention" : "plain",
      line: asking ? settings.question : settings.line,
      back: copy.backShort(settingsTree.filter((node) => node.edge === "returned").length, 2),
      subagents: settingsTree,
    },
  ];

  const recent: AerialRecent[] = [
    ...(reached("end:webhooks")
      ? [
          {
            id: "webhooks",
            project: "lumen-api" as const,
            agent: AGENTS.sol,
            title: story.titles.webhooks,
            subagents: 1,
            ended: copy.now,
            unread: true,
          },
        ]
      : []),
    {
      id: "changelog",
      project: "docs",
      agent: AGENTS.dsFlash,
      title: story.titles.changelog,
      subagents: 0,
      ended: copy.ageMinutes(12),
    },
  ];

  const chats: SidebarChat[] = [
    {
      title: story.titles.darkmode,
      project: "lumen-web",
      provider: "antigravity",
      working: !asking,
      waiting: asking,
    },
    { title: story.titles.passkeys, project: "lumen-web", provider: "claude", working: true },
    {
      title: story.titles.webhooks,
      project: "lumen-api",
      provider: "codex",
      working: !reached("end:webhooks"),
      unread: reached("end:webhooks"),
    },
    { title: story.titles.ratelimit, project: "lumen-api", provider: "codex", working: false },
    { title: story.titles.changelog, project: "docs", provider: "opencode", working: false },
  ];

  return (
    <div ref={root} className="w-full">
      <Stage {...CAPTURE_DEMOS.aerial}>
        {() => (
          <AppWindow
            key={timeline.loop}
            sidebar={<AppSidebar chats={chats} selection={{ kind: "inbox" }} />}
            tabs={
              <>
                <Tab icon={<InboxIcon className="size-4" />} label={copy.inbox} closable={false} />
                <Tab
                  icon={
                    asking ? (
                      <AgentQuestionIcon className="size-4 text-[#e25507] dark:text-[#ff8549]" />
                    ) : (
                      <SpinnerIcon className="size-4 text-app-muted" animationDurationMs={2_000} />
                    )
                  }
                  label={copy.aerialView}
                  active
                />
              </>
            }
          >
            <AerialView active={active} recent={recent} still={still} />
          </AppWindow>
        )}
      </Stage>
    </div>
  );
}

/** A live elapsed-time label, ticking without re-rendering the map. */
function Clock({
  elapsed,
  start,
}: {
  readonly elapsed: MotionValue<number>;
  readonly start: number;
}) {
  const copy = useReplicaCopy();
  const label = useTransform(elapsed, (t) =>
    copy.elapsedMinutes(start + Math.floor(t / MINUTE_MS)),
  );
  return <motion.span>{label}</motion.span>;
}
