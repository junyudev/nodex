import { motion } from "motion/react";

/**
 * A live connection between two things in a diagram: a quiet line that draws itself in, dashes
 * running along it from start to end while `flowing`, and a dot sent back from end to start each
 * time `pulse` changes.
 */
export function FlowEdge({
  d,
  color,
  flowing,
  pulse,
  pulseSeconds = 0.7,
}: {
  readonly d: string;
  readonly color: string;
  readonly flowing: boolean;
  readonly pulse: string | null;
  readonly pulseSeconds?: number;
}) {
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
      {flowing ? (
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
      ) : null}
      {pulse ? (
        <motion.circle
          key={pulse}
          r={4}
          fill={color}
          style={{ offsetPath: `path("${d}")` }}
          initial={{ offsetDistance: "100%", opacity: 1 }}
          animate={{ offsetDistance: "0%", opacity: 0 }}
          transition={{
            offsetDistance: { duration: pulseSeconds, ease: "easeIn" },
            opacity: { delay: pulseSeconds - 0.1, duration: 0.2 },
          }}
        />
      ) : null}
    </g>
  );
}
