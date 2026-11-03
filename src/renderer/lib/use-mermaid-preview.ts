import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  MermaidRenderError,
  renderMermaidDiagram,
  type MermaidRenderResult,
  type MermaidRenderTheme,
} from "./mermaid-runtime";

export type MermaidPreviewState =
  | { readonly status: "empty"; readonly result?: undefined; readonly error?: undefined }
  | {
      readonly status: "rendering";
      readonly result?: MermaidRenderResult;
      readonly error?: undefined;
    }
  | { readonly status: "ready"; readonly result: MermaidRenderResult; readonly error?: undefined }
  | { readonly status: "error"; readonly result?: MermaidRenderResult; readonly error: string };

export function useMermaidPreview(
  source: string,
  theme: MermaidRenderTheme,
  enabled = true,
): MermaidPreviewState {
  const [state, setState] = useState<MermaidPreviewState>({ status: "empty" });
  const lastResultRef = useRef<MermaidRenderResult | undefined>(undefined);
  const setLatestState = useEffectEvent((next: MermaidPreviewState) => setState(next));

  const normalizedSource = source.trim();
  if ((!enabled || !normalizedSource) && state.status !== "empty") {
    setState({ status: "empty" });
  }

  useEffect(() => {
    const normalizedSource = source.trim();
    if (!enabled || !normalizedSource) return;

    let stale = false;
    const timeout = window.setTimeout(() => {
      if (stale) return;
      setLatestState(
        lastResultRef.current
          ? { status: "rendering", result: lastResultRef.current }
          : { status: "rendering" },
      );
      void renderMermaidDiagram({ source: normalizedSource, theme }).then(
        (result) => {
          if (stale) return;
          lastResultRef.current = result;
          setLatestState({ status: "ready", result });
        },
        (error: unknown) => {
          if (stale) return;
          const message =
            error instanceof MermaidRenderError ? error.message : "Could not render this diagram";
          setLatestState(
            lastResultRef.current
              ? { status: "error", result: lastResultRef.current, error: message }
              : { status: "error", error: message },
          );
        },
      );
    }, 300);

    return () => {
      stale = true;
      window.clearTimeout(timeout);
    };
  }, [enabled, source, theme]);

  return state;
}
