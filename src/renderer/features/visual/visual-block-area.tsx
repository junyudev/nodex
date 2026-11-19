import { useEffect, useState } from "react";
import type { VisualAppearance, VisualPageContext } from "../../../shared/visual/bridge";
import type { VisualFrameState } from "./use-visual-frame";
import { VisualBlockChrome } from "./visual-block-chrome";
import { VisualFrame } from "./visual-frame";

/** A Visual code block's rendered figure with the controls people use on it. */
export function VisualBlockArea({
  blockId,
  source,
  appearance,
  page,
  snapshotKey,
  editable,
  sourceShown,
  onToggleSource,
  onWriteSource,
}: {
  readonly blockId: string;
  readonly source: string;
  readonly appearance: VisualAppearance;
  readonly page: VisualPageContext | null;
  readonly snapshotKey: string;
  readonly editable: boolean;
  readonly sourceShown: boolean;
  readonly onToggleSource: () => void;
  readonly onWriteSource: (next: string) => void;
}) {
  const [state, setState] = useState<VisualFrameState | null>(null);
  return (
    <VisualBlockChrome
      blockId={blockId}
      source={source}
      state={state}
      page={page}
      editable={editable}
      sourceShown={sourceShown}
      onToggleSource={onToggleSource}
      onWriteSource={onWriteSource}
    >
      <VisualFrame
        source={source}
        appearance={appearance}
        page={page}
        snapshotKey={snapshotKey}
        onStateChange={setState}
      />
    </VisualBlockChrome>
  );
}

/** Escape leaves a Visual's comment or text mode; the chrome registers it only while active. */
export function useEscapeToLeave(active: boolean, leave: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      leave();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, leave]);
}
