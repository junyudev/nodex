import { motion } from "motion/react";
import { COLD_START_FINDINGS } from "./lumen";
import { useTyped, type Timeline } from "./timeline";

/**
 * The findings the cold-start chat writes into its Page, typed in as they land. A demo marks
 * each one's arrival with a `finding:<index>` cue at the matching `startAt` time.
 */
export function ColdStartFindings({
  timeline,
  startAt,
}: {
  readonly timeline: Timeline;
  readonly startAt: readonly number[];
}) {
  const { reached } = timeline;
  if (!reached("finding:0")) return null;
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="mt-3.5 px-0.5 text-[14.5px] leading-5 font-semibold"
      >
        Findings
      </motion.div>
      <ol className="mt-1.5 flex flex-col gap-1.5 pl-1.5">
        {COLD_START_FINDINGS.map((text, index) =>
          reached(`finding:${index}`) ? (
            <Finding
              key={text}
              index={index}
              text={text}
              start={startAt[index]!}
              timeline={timeline}
            />
          ) : null,
        )}
      </ol>
    </>
  );
}

function Finding({
  index,
  text,
  start,
  timeline,
}: {
  readonly index: number;
  readonly text: string;
  readonly start: number;
  readonly timeline: Timeline;
}) {
  const typed = useTyped(timeline.elapsed, text, start, 9);
  return (
    <li className="flex gap-2">
      <span className="w-3 shrink-0 text-right tabular-nums">{index + 1}.</span>
      <motion.span>{typed}</motion.span>
    </li>
  );
}
