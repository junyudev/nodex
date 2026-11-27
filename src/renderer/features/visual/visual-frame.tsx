import { useEffect, useEffectEvent } from "react";
import { useVisualFrame, type VisualFrameInput, type VisualFrameState } from "./use-visual-frame";

export interface VisualFrameProps extends VisualFrameInput {
  readonly className?: string;
  readonly onStateChange?: (state: VisualFrameState) => void;
}

/** The Page editor can place controls and anchored Discussions around this frame. */
export function VisualFrame({ className, onStateChange, ...input }: VisualFrameProps) {
  const { mount, state } = useVisualFrame(input);
  const report = useEffectEvent(onStateChange ?? (() => {}));
  const { active, diagnostics, figures, frame, loading, rows } = state;
  useEffect(() => {
    report({ active, diagnostics, figures, frame, loading, rows });
  }, [active, diagnostics, figures, frame, loading, rows]);
  const error = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  return (
    <div className={className} contentEditable={false} data-visual-frame>
      <div style={{ position: "relative", minHeight: 1 }}>
        <div ref={mount} style={active ? undefined : { position: "absolute", inset: 0 }} />
        {frame && !active && (
          <img
            alt={figures.map(({ caption }) => caption).join(" · ") || "Visual"}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(frame.svg)}`}
            width={frame.width}
            height={frame.height}
          />
        )}
      </div>
      {error && <span role="status">{error.message}</span>}
    </div>
  );
}
