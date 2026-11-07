import { AnimatePresence, motion, type MotionValue } from "motion/react";
import { useRef, type ReactNode } from "react";
import { LockIcon } from "../replica/icons";
import {
  PHONE_OUTER_WIDTH,
  PHONE_WIDTH,
  PhoneApprovalCard,
  PhoneAssistantRow,
  PhoneChatBar,
  PhoneChatList,
  PhoneComposer,
  PhoneFrame,
  PhoneHomeBar,
  PhoneInboxRow,
  PhonePendingLine,
  PhoneQuietLine,
  PhoneSuggestion,
  PhoneUserRow,
  PhoneWorkRow,
  phoneOuterHeight,
  type PhoneChat,
} from "../replica/Phone";
import { AppSidebar, type SidebarChat } from "../replica/Sidebar";
import { Stage } from "../replica/Stage";
import { AppWindow, Tab, cx } from "../replica/Window";
import { CAPTURE_DEMOS } from "./capture-demos";
import { Touch } from "./Cursor";
import { FlowEdge } from "./FlowEdge";
import { AGENTS, INBOX_BURST, type InboxMessage } from "./lumen";
import { useTimeline, useTyped, type Cue, type TimelineScript } from "./timeline";

const { width: WIDTH, height: HEIGHT } = CAPTURE_DEMOS.mobile;

const PASSKEY = INBOX_BURST.find(({ id }) => id === "passkeys") as InboxMessage;
const COMMAND = "pnpm test:e2e --filter passkeys";
const CAPTURE = "Passkey prompt flickers on iPad Safari";
const NEW_CHAT = "Passkey prompt flicker";

/** Each tap the demo makes: the finger arrives, presses, and lifts when the screen answers. */
const TAPS = [
  { name: "ask", target: "chat:Passkey sign-in", aim: 450, press: 800, done: "chat" },
  { name: "approve", target: "approve", aim: 1800, press: 2300, done: "approved" },
  { name: "back", target: "back", aim: 5150, press: 5500, done: "back" },
  { name: "inbox", target: "segment:inbox", aim: 5850, press: 6200, done: "inbox" },
  { name: "compose", target: "composer", aim: 6600, press: 6900, done: "focus" },
  { name: "send", target: "send", aim: 7950, press: 8200, done: "sent" },
  { name: "start", target: "start", aim: 10500, press: 10900, done: "started" },
] as const;

/** How long a tap takes to travel from the phone to the computer. */
const ARRIVAL_MS = 450;
const TYPE_AT = 7100;
const TYPE_MS = 20;
const CHATS_AT = 11550;

const CUES: readonly Cue[] = [
  { id: "home", at: 100 },
  ...TAPS.flatMap((tap) => [
    { id: `aim:${tap.name}`, at: tap.aim },
    { id: `press:${tap.name}`, at: tap.press },
  ]),
  { id: "chat", at: 950 },
  { id: "approved", at: 2450 },
  { id: "arrive:approved", at: 2450 + ARRIVAL_MS },
  { id: "reply", at: 3900 },
  { id: "roam", at: 4600 },
  { id: "back", at: 5650 },
  { id: "inbox", at: 6350 },
  { id: "focus", at: 7050 },
  { id: "type", at: TYPE_AT },
  { id: "sent", at: 8350 },
  { id: "arrive:sent", at: 8350 + ARRIVAL_MS },
  { id: "suggested", at: 9900 },
  { id: "started", at: 11050 },
  { id: "arrive:started", at: 11050 + ARRIVAL_MS },
  { id: "chats", at: CHATS_AT },
];

export const SCRIPT: TimelineScript = { cues: CUES, durationMs: CHATS_AT + 2450 };

// Wide layout, in stage pixels: the computer on the left, the phone in front on the right.
const PHONE_HEIGHT = 800;
const PHONE_SCALE = 0.66;
const PHONE_LEFT = WIDTH - 16 - PHONE_OUTER_WIDTH * PHONE_SCALE;
const PHONE_TOP = 15;
const LAPTOP = { left: 38, top: 28, width: 400, height: 272, scale: 0.8 };
const LAPTOP_BOTTOM = LAPTOP.top + LAPTOP.height + 14 + 9;
const LAPTOP_CENTER = LAPTOP.left + (LAPTOP.width + 14) / 2;
const ROUTES_CARD = { left: 24, top: 352, width: 262 };
const ROUTE_Y = { lan: ROUTES_CARD.top + 50, tailnet: ROUTES_CARD.top + 82 } as const;
const PHONE_LINK_Y = PHONE_TOP + 400;

// Narrow layout: the phone alone at a readable size, under a strip that names the routes.
const COMPACT = { width: 380, stripHeight: 44, phoneHeight: 720, phoneScale: 0.9 };
const COMPACT_HEIGHT =
  COMPACT.stripHeight + 14 + phoneOuterHeight(COMPACT.phoneHeight) * COMPACT.phoneScale + 14;

type Route = keyof typeof ROUTE_Y;

/**
 * The line runs behind the routes card, so it reads as computer to route and route to phone,
 * and a pulse sent from the phone travels the whole way home.
 */
const linkPath = (route: Route) => {
  const y = ROUTE_Y[route];
  const cardRight = ROUTES_CARD.left + ROUTES_CARD.width;
  return `M${LAPTOP_CENTER},${LAPTOP_BOTTOM} L${LAPTOP_CENTER},${y} L${cardRight},${y} C${cardRight + 34},${y} ${PHONE_LEFT - 34},${PHONE_LINK_Y} ${PHONE_LEFT + 4},${PHONE_LINK_Y}`;
};

/** The same chats, on the computer that runs them and the phone that reaches them. */
export default function MobileDemo() {
  const root = useRef<HTMLDivElement | null>(null);
  const timeline = useTimeline(SCRIPT, root);
  const { reached, elapsed } = timeline;
  const typed = useTyped(elapsed, CAPTURE, TYPE_AT, TYPE_MS);
  const route: Route = reached("roam") ? "tailnet" : "lan";
  // Only while a tap is on its way, so the line drawing itself onto a new route replays nothing.
  const pulse =
    ["approved", "sent", "started"].find((id) => reached(id) && !reached(`arrive:${id}`)) ?? null;

  const phone = (height: number, scale: number) => (
    <PhoneFrame
      height={height}
      scale={scale}
      network={route === "lan" ? "wifi" : "cellular"}
      overlay={<PhoneTouch reached={reached} />}
    >
      <PhoneScreens reached={reached} typed={typed} />
    </PhoneFrame>
  );

  return (
    <div ref={root} className="w-full">
      <Stage
        width={WIDTH}
        height={HEIGHT}
        compactWidth={COMPACT.width}
        compactHeight={COMPACT_HEIGHT}
        compactBelow={500}
      >
        {({ compact }) => (
          <div
            key={timeline.loop}
            className="relative h-full w-full overflow-hidden rounded-2xl border border-line bg-raised bg-[radial-gradient(var(--site-line)_1px,transparent_1px)] [background-size:18px_18px] font-app text-[13px] text-ink"
          >
            {compact ? (
              <div className="flex h-full flex-col items-center gap-3.5">
                <RouteStrip route={route} />
                {phone(COMPACT.phoneHeight, COMPACT.phoneScale)}
              </div>
            ) : (
              <>
                <svg className="absolute inset-0" width={WIDTH} height={HEIGHT} aria-hidden="true">
                  <FlowEdge
                    key={route}
                    d={linkPath(route)}
                    color="var(--phone-accent)"
                    flowing={!timeline.still}
                    pulse={pulse}
                    pulseSeconds={ARRIVAL_MS / 1000}
                  />
                </svg>
                <Laptop>
                  <ComputerScreen reached={reached} />
                </Laptop>
                <RoutesCard route={route} />
                <div className="absolute" style={{ left: PHONE_LEFT, top: PHONE_TOP }}>
                  {phone(PHONE_HEIGHT, PHONE_SCALE)}
                </div>
              </>
            )}
          </div>
        )}
      </Stage>
    </div>
  );
}

type Reached = (id: string) => boolean;

function PhoneTouch({ reached }: { readonly reached: Reached }) {
  const tap = TAPS.find(({ name, done }) => reached(`aim:${name}`) && !reached(done));
  return (
    <Touch
      target={tap?.target ?? null}
      pressed={tap !== undefined && reached(`press:${tap.name}`)}
      rest={{ x: PHONE_WIDTH / 2, y: PHONE_HEIGHT * 0.7 }}
    />
  );
}

function PhoneScreens({
  reached,
  typed,
}: {
  readonly reached: Reached;
  readonly typed: MotionValue<string>;
}) {
  const inChat = reached("chat") && !reached("back");
  const onInbox = reached("inbox") && !reached("chats");
  const approved = reached("approved");
  const replied = reached("reply");
  const delivered = reached("arrive:sent");
  const started = reached("started");

  const chats: readonly PhoneChat[] = [
    {
      title: "Passkey sign-in",
      project: "lumen-web",
      status: replied ? "idle" : approved ? "running" : "waiting",
      attention: COMMAND,
      preview: "All 14 sign-in tests pass.",
      unread: replied && !inChat,
      age: replied ? "now" : "4m",
    },
    ...(reached("chats")
      ? [{ title: NEW_CHAT, project: "lumen-web", status: "running", age: "now" } as const]
      : []),
    { title: "Idempotent Stripe webhooks", project: "lumen-api", status: "running", age: "6m" },
    {
      title: "Dashboard cold start",
      project: "lumen-web",
      status: "idle",
      preview: "Report attached to the Page.",
      age: "38m",
    },
    {
      title: "v2.4 changelog",
      project: "docs",
      status: "idle",
      preview: "Draft ready for review.",
      age: "1h",
    },
  ];

  return (
    <>
      <motion.div
        className="absolute inset-0"
        initial={false}
        animate={{ x: inChat ? -PHONE_WIDTH * 0.3 : 0 }}
        transition={PUSH}
      >
        <PhoneHomeBar
          mode={onInbox ? "inbox" : "chats"}
          inboxCount={delivered && !started ? 3 : 2}
          attentionCount={approved ? 0 : 1}
        />
        <motion.div
          className="absolute inset-y-0 left-0 flex"
          style={{ width: PHONE_WIDTH * 2 }}
          initial={false}
          animate={{ x: onInbox ? 0 : -PHONE_WIDTH }}
          transition={PUSH}
        >
          <div className="h-full shrink-0" style={{ width: PHONE_WIDTH }}>
            <InboxPane reached={reached} typed={typed} />
          </div>
          <div className="relative h-full shrink-0" style={{ width: PHONE_WIDTH }}>
            <PhoneChatList chats={chats} />
            <div className="absolute inset-x-0 bottom-0">
              <PhoneComposer placeholder="Start a chat in lumen-web" send="empty" />
            </div>
          </div>
        </motion.div>
      </motion.div>
      <motion.div
        className="absolute inset-0 bg-phone-surface"
        initial={false}
        animate={{ x: inChat ? 0 : PHONE_WIDTH }}
        transition={PUSH}
      >
        <ChatPane approved={approved} replied={replied} />
      </motion.div>
    </>
  );
}

const PUSH = { duration: 0.38, ease: [0.25, 0.8, 0.25, 1] } as const;

function ChatPane({
  approved,
  replied,
}: {
  readonly approved: boolean;
  readonly replied: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      <PhoneChatBar title="Passkey sign-in" subtitle={`lumen-web · ${AGENTS.opus.model}`} />
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
        <PhoneUserRow>{PASSKEY.text}</PhoneUserRow>
        <PhoneWorkRow title="9 steps" running={false} />
        <PhoneAssistantRow>
          Handed the routes, migration, tests and docs to subagents. I’ll take the session flow.
        </PhoneAssistantRow>
        <PhoneWorkRow title="23 steps" running={false} />
        <PhoneAssistantRow>
          Routes, migration and docs are merged. One check left: the sign-in suite.
        </PhoneAssistantRow>
        {approved ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <PhoneWorkRow title={replied ? "1 step" : `Running ${COMMAND}`} running={!replied} />
          </motion.div>
        ) : null}
        {replied ? (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            <PhoneAssistantRow>
              All 14 sign-in tests pass, with passkeys and with the password fallback. Ready for
              review.
            </PhoneAssistantRow>
          </motion.div>
        ) : null}
        <div className="h-3 shrink-0" />
      </div>
      <AnimatePresence initial={false}>
        {approved ? null : (
          <motion.div
            className="pb-2"
            exit={{ opacity: 0, height: 0, paddingBottom: 0 }}
            transition={{ duration: 0.22 }}
          >
            <PhoneApprovalCard
              title="Command approval"
              detail={COMMAND}
              options={[
                { label: "Decline", tone: "danger" },
                { label: "Approve", tone: "primary", cursorTarget: "approve" },
                { label: "Allow for this chat", tone: "default" },
              ]}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <PhoneComposer
        placeholder={replied ? "Reply" : "Add to the queue"}
        send={replied ? "empty" : "stop"}
      />
    </div>
  );
}

function InboxPane({
  reached,
  typed,
}: {
  readonly reached: Reached;
  readonly typed: MotionValue<string>;
}) {
  const typing = reached("type") && !reached("sent");
  const focused = reached("focus") && !reached("sent");
  const sent = reached("sent");
  const delivered = reached("arrive:sent");
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
        <PhoneInboxRow text="idea: weekly digest email for workspace owners" meta="8:52">
          <PhoneSuggestion
            summary="An idea, not work to start yet. Keep it as a note."
            destination={`Suggested by ${AGENTS.sol.model}`}
            action={{ label: "Keep", tone: "primary", icon: "check" }}
          />
        </PhoneInboxRow>
        <PhoneInboxRow text="settings dark mode looks washed out" meta="9:03">
          <PhoneSuggestion
            summary="Check contrast on surfaces and secondary text."
            destination="Settings redesign"
            action={{ label: "Send to chat", tone: "primary", icon: "chat" }}
          />
        </PhoneInboxRow>
        {sent ? (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <PhoneInboxRow text={CAPTURE} faded={!delivered} meta={delivered ? "9:41" : undefined}>
              {delivered ? (
                <CaptureAdvice reached={reached} />
              ) : (
                <PhonePendingLine text="Sending" />
              )}
            </PhoneInboxRow>
          </motion.div>
        ) : null}
      </div>
      <PhoneComposer
        placeholder="Drop a thought in Library"
        text={typing ? <motion.span>{typed}</motion.span> : null}
        chip={focused ? { icon: "inbox", label: "Library" } : null}
        send={typing ? "ready" : "empty"}
      />
    </div>
  );
}

function CaptureAdvice({ reached }: { readonly reached: Reached }) {
  if (reached("started")) return <PhoneQuietLine text="Delivering" />;
  if (!reached("suggested")) return <PhoneQuietLine text="Looking at this" />;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <PhoneSuggestion
        summary="Reproduce the flicker on iPad Safari, fix it and add a regression test."
        destination="lumen-web"
        action={{ label: "Start chat", tone: "primary", icon: "chat", cursorTarget: "start" }}
      />
    </motion.div>
  );
}

function Laptop({ children }: { readonly children: ReactNode }) {
  const { left, top, width, height, scale } = LAPTOP;
  return (
    <div className="absolute" style={{ left, top, width: width + 14 }}>
      <div className="rounded-t-[13px] rounded-b-[3px] bg-[#0a0a0c] p-[7px] shadow-[0_0_0_1px_rgb(255_255_255/0.14),0_30px_60px_-30px_rgb(0_0_0/0.6)]">
        <div className="relative overflow-hidden rounded-[5px]" style={{ height }}>
          <div
            className="absolute top-0 left-0 origin-top-left"
            style={{ width: width / scale, height: height / scale, transform: `scale(${scale})` }}
          >
            {children}
          </div>
        </div>
      </div>
      <div className="relative -mx-[18px] h-[9px] rounded-t-[1px] rounded-b-[9px] bg-linear-to-b from-device-body to-device-body-2">
        <span className="absolute top-0 left-1/2 h-[3px] w-[58px] -translate-x-1/2 rounded-b-[4px] bg-black/25" />
      </div>
    </div>
  );
}

/** Nodex on the computer: what a tap on the phone changes shows up here, where the work runs. */
function ComputerScreen({ reached }: { readonly reached: Reached }) {
  const approved = reached("arrive:approved");
  const replied = reached("reply");
  const started = reached("arrive:started");
  const chats: readonly SidebarChat[] = [
    {
      title: "Passkey sign-in",
      project: "lumen-web",
      provider: "claude",
      working: approved && !replied,
      waiting: !approved,
    },
    ...(started
      ? [{ title: NEW_CHAT, project: "lumen-web", provider: "codex", working: true } as const]
      : []),
    { title: "Dashboard cold start", project: "lumen-web", provider: "opencode", working: false },
    {
      title: "Idempotent Stripe webhooks",
      project: "lumen-api",
      provider: "codex",
      working: true,
    },
    { title: "v2.4 changelog", project: "docs", provider: "opencode", working: false },
  ];
  return (
    <AppWindow
      rail={false}
      className="rounded-none! shadow-none!"
      tabs={<Tab label="Passkey sign-in" titleOnly />}
      sidebar={
        <AppSidebar
          chats={chats}
          inboxCount={reached("arrive:sent") && !started ? 3 : 2}
          selection={{ kind: "chat", title: "Passkey sign-in" }}
        />
      }
    >
      <div className="absolute inset-0 flex flex-col justify-end gap-3 p-4 text-[12px] leading-[18px]">
        <p>Handed the routes, migration, tests and docs to subagents.</p>
        <p>Routes, migration and docs are merged. One check left: the sign-in suite.</p>
        {approved ? (
          <p className="text-app-muted">{replied ? "1 step" : `Running ${COMMAND}`}</p>
        ) : (
          <p className="rounded-lg bg-app-hover p-2 font-mono text-[11px]">{COMMAND}</p>
        )}
        {replied ? <p>All 14 sign-in tests pass, with passkeys and the fallback.</p> : null}
      </div>
    </AppWindow>
  );
}

function RouteDot({ active }: { readonly active: boolean }) {
  return (
    <span
      className={cx(
        "size-1.5 shrink-0 rounded-full transition-colors duration-300",
        active ? "bg-phone-accent" : "bg-ink-3/40",
      )}
    />
  );
}

const ROUTES = [
  { id: "lan", name: "Home Wi-Fi", address: "192.168.1.24" },
  { id: "tailnet", name: "Tailscale", address: "100.101.62.18" },
] as const satisfies readonly {
  readonly id: Route;
  readonly name: string;
  readonly address: string;
}[];

/** How the desktop lists where a phone can reach it, with the route the phone is using lit up. */
function RoutesCard({ route }: { readonly route: Route }) {
  return (
    <div
      className="absolute flex flex-col rounded-xl border border-line bg-page p-3 shadow-[0_18px_40px_-20px_rgb(0_0_0/0.6)]"
      style={ROUTES_CARD}
    >
      <span className="px-2 pb-1 text-[12px] leading-[18px] text-ink-3">Reachable at</span>
      {ROUTES.map(({ id, name, address }) => (
        <span
          key={id}
          className={cx(
            "flex h-8 items-center gap-2 rounded-lg px-2 transition-colors duration-300",
            route === id && "bg-app-hover",
          )}
        >
          <RouteDot active={route === id} />
          <span className={cx("flex-1", route === id ? "font-medium text-ink" : "text-ink-2")}>
            {name}
          </span>
          <span className="font-mono text-[11px] text-ink-3">{address}</span>
        </span>
      ))}
      <span className="mt-2 flex items-center gap-1.5 border-t border-line px-2 pt-2.5 text-[12px] leading-4 text-ink-2">
        <LockIcon className="size-3.5 text-ink-3" />
        Direct, encrypted end to end
      </span>
    </div>
  );
}

/** The routes for a screen too narrow to draw the computer beside the phone. */
function RouteStrip({ route }: { readonly route: Route }) {
  return (
    <div
      className="flex w-full shrink-0 items-center justify-center gap-1 border-b border-line bg-page px-3"
      style={{ height: COMPACT.stripHeight }}
    >
      {ROUTES.map(({ id, name }) => (
        <span
          key={id}
          className={cx(
            "flex h-7 items-center gap-1.5 rounded-lg px-2 transition-colors duration-300",
            route === id ? "bg-app-hover font-medium text-ink" : "text-ink-3",
          )}
        >
          <RouteDot active={route === id} />
          {name}
        </span>
      ))}
      <span className="ml-1 flex items-center gap-1 text-[12px] text-ink-3">
        <LockIcon className="size-3.5" />
        Encrypted
      </span>
    </div>
  );
}
