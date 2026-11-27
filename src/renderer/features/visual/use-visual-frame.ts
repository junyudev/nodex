import { useEffect, useEffectEvent, useState } from "react";
import {
  defaultVisualTheme,
  type VisualAppearance,
  type VisualGrant,
  type VisualPageContext,
  type VisualRenderFrame,
  type VisualTheme,
} from "../../../shared/visual/bridge";
import {
  VISUAL_LIMITS,
  type VisualDiagnostic,
  type VisualFigure,
  type VisualRows,
} from "../../../shared/visual/contract";
import { readInlineVisualizationStyleVariables } from "../../lib/inline-visualization/inline-visualization-style-variables";
import { scheduleInlineVisualizationIdle } from "../../lib/inline-visualization/inline-visualization-standby";
import { inspectVisualSource } from "./visual-source";
import { visualAdapter } from "./visual-adapter";
import { requestVisualGuestSlot } from "./visual-guest-slots";

export interface VisualFrameInput {
  readonly source: string;
  readonly appearance: VisualAppearance;
  readonly page?: VisualPageContext | null;
  /** Use a stable page-scoped Block identity to keep its latest snapshot across mounts. */
  readonly snapshotKey?: string;
  /** Set after a change to a referenced File or table. */
  readonly sourceRevision?: string | number;
  readonly theme?: VisualTheme;
}

export interface VisualFrameState {
  readonly frame: VisualRenderFrame | null;
  readonly diagnostics: readonly VisualDiagnostic[];
  readonly figures: readonly VisualFigure[];
  readonly rows: VisualRows | null;
  readonly active: boolean;
  readonly loading: boolean;
}

type Lease = {
  epoch: number;
  grant: VisualGrant;
  enqueue: (task: () => Promise<void>, failed: (error: unknown) => void) => void;
  resize: (height: number) => void;
  show: (show: boolean) => void;
};

const EMPTY_DIAGNOSTICS: readonly VisualDiagnostic[] = [];
const EMPTY_FIGURES: readonly VisualFigure[] = [];

const snapshots = new Map<string, VisualRenderFrame>();
function remember(key: string, frame: VisualRenderFrame) {
  snapshots.delete(key);
  snapshots.set(key, frame);
  if (snapshots.size > 24) snapshots.delete(snapshots.keys().next().value!);
}
function failure(error: unknown): VisualDiagnostic[] {
  return [
    {
      severity: "error",
      code: "render",
      message:
        error instanceof Error ? error.message.slice(0, 500) : "Visual preview is unavailable",
    },
  ];
}

export function useVisualFrame({
  source,
  page,
  snapshotKey,
  appearance,
  sourceRevision,
  theme,
}: VisualFrameInput) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [attachedLease, setLease] = useState<Lease | null>(null);
  const [revision, setRevision] = useState(0);
  const [guestEpoch, setGuestEpoch] = useState(0);
  const lease = attachedLease?.epoch === guestEpoch ? attachedLease : null;
  const [failedRender, setFailedRender] = useState<{
    source: string;
    appearance: VisualAppearance;
    revision: number;
    sourceRevision: VisualFrameInput["sourceRevision"];
  } | null>(null);
  const [outcome, setOutcome] = useState<{
    forLease: Lease;
    source: string;
    appearance: VisualAppearance;
    revision: number;
    externalRevision: typeof sourceRevision;
    result: VisualFrameState;
  } | null>(null);
  const [attachmentError, setAttachmentError] =
    useState<readonly VisualDiagnostic[]>(EMPTY_DIAGNOSTICS);
  const [lastFrame, setLastFrame] = useState<VisualRenderFrame | null>(null);
  const paused =
    failedRender?.source === source &&
    failedRender.appearance === appearance &&
    failedRender.revision === revision &&
    failedRender.sourceRevision === sourceRevision;
  const cacheKey = snapshotKey && JSON.stringify([snapshotKey, appearance]);
  const pageId = page?.pageId ?? null;
  const projectId = page?.routingContext.kind === "project" ? page.routingContext.projectId : null;
  const variables = useEffectEvent(() => ({
    ...defaultVisualTheme(appearance),
    variables: readInlineVisualizationStyleVariables(),
  }));

  useEffect(() => {
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { rootMargin: "120px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  useEffect(() => {
    if (!element || !visible || paused) return;
    let disposed = false;
    let retired = false;
    let grant: VisualGrant | null = null;
    let view: Electron.WebviewTag | undefined;
    let releaseSlot: (() => void) | undefined;
    let clearWatchdog: (() => void) | undefined;
    const retire = () => {
      if (retired) return;
      retired = true;
      clearWatchdog?.();
      view?.remove();
      if (!grant) {
        releaseSlot?.();
        return;
      }
      void visualAdapter
        .release(grant.grant)
        .catch(() => {})
        .finally(() => releaseSlot?.());
    };
    const cancelIdle = scheduleInlineVisualizationIdle(() => {
      if (disposed) return;
      releaseSlot = requestVisualGuestSlot(() => {
        void visualAdapter
          .admit()
          .then((admission) => {
            if (disposed) {
              if (admission) void visualAdapter.release(admission.grant).catch(() => {});
              return;
            }
            if (!admission) throw new Error("Visual guest is unavailable");
            grant = admission;
            const webview = document.createElement("webview");
            view = webview;
            webview.setAttribute("partition", admission.partition);
            webview.setAttribute("src", admission.url);
            webview.setAttribute("aria-label", "Visual");
            Object.assign(webview.style, {
              width: "100%",
              height: "320px",
              // A webview sizes its inner frame with flex; any other display leaves the frame at
              // the iframe default height and clips taller figures.
              display: "flex",
              // The figure is static. The Page hit-tests its data points and text from the
              // guest's geometry, and the wheel keeps scrolling the Page.
              pointerEvents: "none",
              visibility: "hidden",
            });
            const fail = () => {
              if (disposed) return;
              setAttachmentError(failure(new Error("Visual guest did not start")));
              retire();
            };
            const timer = window.setTimeout(fail, VISUAL_LIMITS.renderMilliseconds);
            clearWatchdog = () => window.clearTimeout(timer);
            webview.addEventListener("did-fail-load", fail);
            const ready = () => {
              webview.removeEventListener("did-finish-load", ready);
              if (disposed || retired) return;
              clearWatchdog?.();
              setAttachmentError(EMPTY_DIAGNOSTICS);
              let pending = Promise.resolve();
              setLease({
                epoch: guestEpoch,
                grant: admission,
                enqueue: (task, failed) => {
                  pending = pending.then(task).catch(failed);
                },
                resize: (height) => {
                  webview.style.height = `${height}px`;
                },
                show: (show) => {
                  webview.style.visibility = show ? "visible" : "hidden";
                },
              });
            };
            webview.addEventListener("did-finish-load", ready);
            element.append(webview);
          })
          .catch((error: unknown) => {
            if (disposed) return;
            setAttachmentError(failure(error));
            retire();
          });
      });
    });
    return () => {
      disposed = true;
      cancelIdle();
      retire();
      setLease(null);
    };
  }, [element, visible, paused, guestEpoch]);

  useEffect(() => {
    if (!lease) return;
    let disposed = false;
    const renderingTheme = theme ?? variables();
    const task = async () => {
      if (disposed) return;
      const context = pageId
        ? {
            pageId,
            routingContext: projectId
              ? { kind: "project" as const, projectId }
              : { kind: "library" as const },
          }
        : null;
      const base = { active: false, frame: null, loading: false };
      const report = (state: VisualFrameState) => {
        if (!disposed)
          setOutcome({
            forLease: lease,
            source,
            appearance,
            revision,
            externalRevision: sourceRevision,
            result: state,
          });
      };
      const syntax = await inspectVisualSource(source);
      if (disposed) return;
      if (!syntax.ok) {
        report({ ...base, rows: null, figures: [], diagnostics: syntax.diagnostics });
        return;
      }
      const result = await visualAdapter.resolveSources(source, context);
      if (disposed) return;
      if (!result.ok) {
        report({ ...base, rows: null, figures: [], diagnostics: result.diagnostics });
        return;
      }
      const rendered = await visualAdapter.render({
        grant: lease.grant.grant,
        source,
        rows: result.rows,
        theme: renderingTheme,
      });
      if (disposed) return;
      if (rendered.status === "renew") {
        setGuestEpoch((value) => value + 1);
        return;
      }
      const data = {
        figures: result.figures,
        rows: result.rows,
        diagnostics: rendered.diagnostics,
      };
      if (rendered.status === "error") {
        if (rendered.retired) {
          setAttachmentError(rendered.diagnostics);
          setFailedRender({ source, appearance, revision, sourceRevision });
        }
        report({ ...base, ...data });
        return;
      }
      const { frame } = rendered;
      lease.resize(frame.height);
      setLastFrame(frame);
      if (cacheKey) remember(cacheKey, frame);
      report({ ...base, ...data, active: true, frame });
    };
    lease.enqueue(task, (error: unknown) => {
      if (disposed) return;
      setOutcome({
        forLease: lease,
        source,
        appearance,
        revision,
        externalRevision: sourceRevision,
        result: {
          active: false,
          loading: false,
          frame: null,
          figures: [],
          rows: null,
          diagnostics: failure(error),
        },
      });
    });
    return () => {
      disposed = true;
    };
  }, [lease, appearance, source, pageId, projectId, cacheKey, revision, sourceRevision, theme]);

  const state =
    outcome?.forLease === lease &&
    outcome.source === source &&
    outcome.appearance === appearance &&
    outcome.revision === revision &&
    outcome.externalRevision === sourceRevision
      ? outcome.result
      : null;
  useEffect(() => {
    lease?.show(Boolean(state?.active));
  }, [lease, state]);
  const diagnostics = state?.diagnostics ?? attachmentError;
  const frame = state?.frame ?? (cacheKey ? snapshots.get(cacheKey) : undefined) ?? lastFrame;
  return {
    mount: setElement,
    capture: (appearances: VisualAppearance[] = [appearance]) =>
      visualAdapter.capture(source, page ?? null, appearances),
    rerender: () => {
      if (attachmentError.length && !paused) setGuestEpoch((value) => value + 1);
      setRevision((value) => value + 1);
    },
    state: {
      frame,
      active: Boolean(state?.active),
      diagnostics,
      figures: state?.figures ?? EMPTY_FIGURES,
      rows: state?.rows ?? null,
      loading: Boolean(visible && !state && attachmentError.length === 0),
    } satisfies VisualFrameState,
  };
}
