import { AnimatePresence, motion, useTransform, type MotionValue } from "motion/react";
import { useRef } from "react";
import { ProviderMark, cx } from "../replica/Window";
import { Stage } from "../replica/Stage";
import { CAPTURE_DEMOS } from "./capture-demos";
import { PASSKEY_SUBAGENTS, PROVIDER_NAMES, type AgentChoice } from "./lumen";
import { useTimeline, type Cue } from "./timeline";

const { width: WIDTH, height: HEIGHT } = CAPTURE_DEMOS.fanout;

interface Child {
  readonly name: string;
  readonly agent: AgentChoice;
  readonly call: string;
  readonly diff: string;
  readonly start: number;
  readonly done: number;
}

/** How each of the passkey chat's subagents is called and how its run plays out here. */
const RUNS = [
  { call: "gpt-6.1-sol · xhigh", diff: "+412 −38", start: 1500, done: 6600 },
  { call: "gpt-6.1-sol · high", diff: "+186 −4", start: 1950, done: 7600 },
  { call: "gpt-6.1-sol · high", diff: "+298", start: 2400, done: 8500 },
  { call: "glm-5.3-flash-free", diff: "+64 −12", start: 2850, done: 5400 },
] as const;

const CHILDREN: readonly Child[] = PASSKEY_SUBAGENTS.map((subagent, index) => ({
  name: subagent.name,
  agent: subagent.agent,
  ...RUNS[index]!,
}));

const EDGE_COLOR: Record<AgentChoice["provider"], string> = {
  claude: "#d97757",
  codex: "#8e9bff",
  opencode: "#e7b549",
};

const LEAD = { x: 20, y: 150, w: 236, h: 124 };
const CHILD_X = 372;
const CHILD_W = 248;
const CHILD_H = 92;
const childY = (index: number) => 28 + index * 122;
const edgePath = (index: number) => {
  const fromX = LEAD.x + LEAD.w;
  const fromY = LEAD.y + LEAD.h / 2;
  const toY = childY(index) + CHILD_H / 2;
  return `M${fromX},${fromY} C${fromX + 64},${fromY} ${CHILD_X - 64},${toY} ${CHILD_X},${toY}`;
};

const MERGED = 9300;

function buildCues(): Cue[] {
  const cues: Cue[] = [
    { id: "lead", at: 250 },
    { id: "list", at: 800 },
  ];
  CHILDREN.forEach((child, index) => {
    cues.push({ id: `start:${index}`, at: child.start }, { id: `done:${index}`, at: child.done });
  });
  cues.push({ id: "wait", at: 3300 }, { id: "merged", at: MERGED });
  return cues;
}

/** Claude Code leading a fan-out to Codex and OpenCode subagents, drawn as the work flows. */
const CUES = buildCues();

export default function FanOutDemo() {
  const root = useRef<HTMLDivElement | null>(null);
  const timeline = useTimeline({ cues: CUES, durationMs: 13000 }, root);
  const { reached, elapsed } = timeline;
  const finished = CHILDREN.filter((_, index) => reached(`done:${index}`)).length;

  return (
    <div ref={root} className="w-full">
      <Stage width={WIDTH} height={HEIGHT}>
        {() => (
          <div
            key={timeline.loop}
            className="relative h-full w-full overflow-hidden rounded-2xl border border-line bg-raised bg-[radial-gradient(var(--site-line)_1px,transparent_1px)] [background-size:18px_18px] font-app text-[13px] text-ink"
          >
            <svg className="absolute inset-0" width={WIDTH} height={HEIGHT} aria-hidden="true">
              {CHILDREN.map((child, index) =>
                reached(`start:${index}`) ? (
                  <Edge
                    key={child.name}
                    index={index}
                    color={EDGE_COLOR[child.agent.provider]}
                    done={reached(`done:${index}`)}
                  />
                ) : null,
              )}
            </svg>

            <AnimatePresence>
              {reached("lead") ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="absolute flex flex-col gap-1.5 rounded-xl border border-line bg-page p-3.5 shadow-[0_18px_40px_-20px_rgb(0_0_0/0.6)]"
                  style={{ left: LEAD.x, top: LEAD.y, width: LEAD.w, minHeight: LEAD.h }}
                >
                  <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
                    <ProviderMark kind="claude" className="size-3.5" /> Claude Code · lead
                  </span>
                  <span className="text-[15px] font-medium">Passkey sign-in</span>
                  <span className="text-[12px] text-ink-2">Claude Opus 5.5 · High</span>
                  <span
                    className={cx(
                      "mt-1 text-[12px]",
                      reached("merged") ? "text-status-ship" : "text-ink-3",
                    )}
                  >
                    {reached("merged")
                      ? "Merged 4 parts · 214 tests pass"
                      : reached("start:0")
                        ? `Delegating · ${finished}/${CHILDREN.length} back`
                        : "Planning the work"}
                  </span>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <div
              className="absolute flex flex-col gap-1 font-mono text-[11px] leading-[18px] text-ink-3"
              style={{ left: LEAD.x + 4, top: LEAD.y + LEAD.h + 22, width: LEAD.w + 80 }}
            >
              {reached("list") ? (
                <CallLine name="list_agent_models" detail="4 agents · 31 models" />
              ) : null}
              {CHILDREN.map((child, index) =>
                reached(`start:${index}`) ? (
                  <CallLine key={child.name} name="delegate_task" detail={child.call} />
                ) : null,
              )}
              {reached("wait") ? (
                <CallLine name="task_wait" detail={reached("merged") ? "4 settled" : "4 tasks"} />
              ) : null}
            </div>

            {CHILDREN.map((child, index) =>
              reached(`start:${index}`) ? (
                <ChildCard
                  key={child.name}
                  child={child}
                  index={index}
                  done={reached(`done:${index}`)}
                  elapsed={elapsed}
                />
              ) : null,
            )}
          </div>
        )}
      </Stage>
    </div>
  );
}

function CallLine({ name, detail }: { readonly name: string; readonly detail: string }) {
  return (
    <motion.span
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      className="truncate"
    >
      <span className="text-ink-2">{name}</span> <span>{detail}</span>
    </motion.span>
  );
}

function Edge({
  index,
  color,
  done,
}: {
  readonly index: number;
  readonly color: string;
  readonly done: boolean;
}) {
  const d = edgePath(index);
  return (
    <g>
      <motion.path
        d={d}
        fill="none"
        stroke={color}
        strokeOpacity={0.35}
        strokeWidth={1.5}
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      />
      {done ? null : (
        <motion.path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray="3 9"
          strokeLinecap="round"
          initial={{ strokeDashoffset: 0, opacity: 0 }}
          animate={{ strokeDashoffset: -48, opacity: 1 }}
          transition={{
            strokeDashoffset: { duration: 1.2, repeat: Infinity, ease: "linear" },
            opacity: { delay: 0.4 },
          }}
        />
      )}
      {done ? (
        <motion.circle
          r={4}
          fill={color}
          style={{ offsetPath: `path("${d}")` }}
          initial={{ offsetDistance: "100%", opacity: 1 }}
          animate={{ offsetDistance: "0%", opacity: 0 }}
          transition={{
            offsetDistance: { duration: 0.7, ease: "easeIn" },
            opacity: { delay: 0.6, duration: 0.2 },
          }}
        />
      ) : null}
    </g>
  );
}

function ChildCard({
  child,
  index,
  done,
  elapsed,
}: {
  readonly child: Child;
  readonly index: number;
  readonly done: boolean;
  readonly elapsed: MotionValue<number>;
}) {
  // A time-lapse: a few real seconds stand for the minutes a subagent works.
  const clock = useTransform(elapsed, (t) => {
    const seconds = Math.max(0, Math.round(((Math.min(t, child.done) - child.start) / 1000) * 26));
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  });
  return (
    <motion.div
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.35, type: "spring", stiffness: 300, damping: 28 }}
      className={cx(
        "absolute flex flex-col gap-1 rounded-xl border bg-page p-3 transition-colors duration-500",
        done ? "border-line" : "border-line",
      )}
      style={{ left: CHILD_X, top: childY(index), width: CHILD_W, height: CHILD_H }}
    >
      <span className="flex items-center justify-between gap-2 text-[12px] text-ink-3">
        <span className="flex items-center gap-1.5">
          <ProviderMark kind={child.agent.provider} className="size-3.5 text-ink" />
          {PROVIDER_NAMES[child.agent.provider]}
          {child.agent.free ? (
            <span className="rounded bg-free/15 px-1 text-[10px] font-medium text-free">FREE</span>
          ) : null}
        </span>
        <span className={cx("tabular-nums", done ? "text-status-ship" : "")}>
          {done ? "Done" : <motion.span>{clock}</motion.span>}
        </span>
      </span>
      <span className="truncate text-[14px] font-medium">{child.name}</span>
      <span className="flex items-center justify-between text-[12px] text-ink-2">
        <span className="truncate">
          {child.agent.model} · {child.agent.effort}
        </span>
        <AnimatePresence>
          {done ? (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="shrink-0 font-mono text-[11px] text-status-ship"
            >
              {child.diff}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </span>
    </motion.div>
  );
}
