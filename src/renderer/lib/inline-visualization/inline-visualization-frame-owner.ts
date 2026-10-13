import type {
  CodexConversationResumeState,
  CodexVisualizationReadResult,
} from "../../../shared/types";
import type { CodexVisualizationStateIdentity } from "../../../shared/codex-visualization-state";
import {
  INLINE_VISUALIZATION_INITIAL_HEIGHT,
  parseInlineVisualizationHeight,
} from "./inline-visualization-document";
import type { InlineVisualizationRuntime } from "./inline-visualization-runtime";
import type {
  InlineVisualizationAnnotationSubmitHandler,
  InlineVisualizationFollowUpHandler,
} from "./inline-visualization-follow-up-context";
import { moveNativeSubtree } from "../move-native-subtree";
import { createInlineVisualizationStandby } from "./inline-visualization-standby";

export interface InlineVisualizationFrameIdentity {
  readonly surfaceId: string;
  readonly hostId: string;
  readonly readHostId: string;
  readonly threadId: string;
  readonly sourceThreadId: string;
  readonly file: string;
  readonly occurrence: string;
}

export const inlineVisualizationFrameKey = (identity: InlineVisualizationFrameIdentity) =>
  JSON.stringify([
    identity.surfaceId,
    identity.hostId,
    identity.readHostId,
    identity.threadId,
    identity.sourceThreadId,
    identity.file,
    identity.occurrence,
  ]);

export interface InlineVisualizationFrameInput {
  readonly identity: InlineVisualizationFrameIdentity;
  readonly fragment: CodexVisualizationReadResult & { readonly contents: string };
  readonly stateIdentity: CodexVisualizationStateIdentity | null;
  readonly attempt: number;
  readonly canExpand: boolean;
  readonly retry: () => void;
  readonly followUp: InlineVisualizationFollowUpHandler | null;
  readonly submitAnnotations: InlineVisualizationAnnotationSubmitHandler | null;
}

export interface InlineVisualizationFrameSnapshot {
  readonly id: string;
  readonly identity: InlineVisualizationFrameIdentity;
  readonly container: HTMLElement;
  readonly fragment: InlineVisualizationFrameInput["fragment"];
  readonly stateIdentity: CodexVisualizationStateIdentity | null;
  readonly documentRevision: number;
  readonly attempt: number;
  readonly initialHeight: number;
  readonly active: boolean;
  readonly canExpand: boolean;
}

export interface InlineVisualizationFrameBinding {
  readonly frameId: string;
  readonly token: symbol;
}

interface Binding extends InlineVisualizationFrameBinding {
  readonly anchor: HTMLElement;
  input: InlineVisualizationFrameInput;
}

interface Frame {
  readonly key: string;
  readonly listeners: Set<() => void>;
  snapshot: InlineVisualizationFrameSnapshot;
  binding: Binding | null;
  runtime: InlineVisualizationRuntime | null;
  height: {
    readonly fragment: WeakRef<InlineVisualizationFrameInput["fragment"]>;
    readonly value: number;
  } | null;
}

const EMPTY_IDS: readonly string[] = [];
const threadKey = (hostId: string, threadId: string) => JSON.stringify([hostId, threadId]);

/** Window-scoped occurrences own native lifetime; anchors own only their current presentation. */
export function createInlineVisualizationFrameOwner(
  platform = {
    createContainer: () => document.createElement("div"),
    move: moveNativeSubtree,
    schedule: (job: () => void) => queueMicrotask(job),
    createId: () => crypto.randomUUID(),
  },
) {
  const standby = createInlineVisualizationStandby();
  const frames = new Map<string, Frame>();
  const byOccurrence = new Map<string, Set<string>>();
  const surfaces = new Map<string, string | null>();
  const resumes = new Map<string, CodexConversationResumeState | null>();
  const listeners = new Set<() => void>();
  let ids: readonly string[] = EMPTY_IDS;
  let parking: HTMLElement | null = null;
  let disposed = false;
  let windowLeases = 0;
  let windowGeneration = 0;
  const emitList = () => {
    ids = frames.size ? [...frames.keys()] : EMPTY_IDS;
    listeners.forEach((listener) => listener());
  };
  const emit = (frame: Frame) => frame.listeners.forEach((listener) => listener());
  const active = (frame: Frame) => {
    const { identity } = frame.snapshot;
    return (
      frame.binding?.anchor.isConnected === true &&
      surfaces.get(identity.surfaceId) === threadKey(identity.hostId, identity.threadId)
    );
  };
  const place = (frame: Frame) => {
    const isActive = active(frame);
    frame.runtime?.setActive(isActive);
    if (isActive !== frame.snapshot.active) {
      frame.snapshot = { ...frame.snapshot, active: isActive };
      emit(frame);
    }
    const target = isActive ? frame.binding?.anchor : parking;
    if (target?.isConnected) platform.move(frame.snapshot.container, target);
    frame.snapshot.container.inert = !isActive;
    frame.snapshot.container.style.visibility = isActive ? "" : "hidden";
  };
  const release = (frame: Frame) => {
    const { id } = frame.snapshot;
    if (frames.get(id) !== frame) return;
    frame.runtime?.setActive(false);
    void frame.runtime?.dispose();
    frame.runtime = null;
    frames.delete(id);
    const occurrences = byOccurrence.get(frame.key);
    occurrences?.delete(id);
    if (!occurrences?.size) byOccurrence.delete(frame.key);
    frame.binding = null;
    frame.height = null;
    frame.snapshot.container.remove();
    emit(frame);
    emitList();
  };
  const releaseIfHistoryInvalidated = (frame: Frame) => {
    if (frame.binding?.anchor.isConnected) return;
    const { identity } = frame.snapshot;
    const key = threadKey(identity.hostId, identity.threadId);
    if (surfaces.get(identity.surfaceId) === key || !resumes.has(key)) return;
    const state = resumes.get(key);
    if (state === null || state === "needs_resume") release(frame);
  };
  const releaseIfUnused = (frame: Frame) => {
    if (frame.binding?.anchor.isConnected) return;
    const { identity } = frame.snapshot;
    if (surfaces.get(identity.surfaceId) === threadKey(identity.hostId, identity.threadId)) {
      release(frame);
      return;
    }
    releaseIfHistoryInvalidated(frame);
  };
  const update = (frame: Frame, input: InlineVisualizationFrameInput) => {
    const previous = frame.snapshot;
    const unchangedFragment =
      previous.fragment.contents === input.fragment.contents &&
      previous.fragment.path === input.fragment.path;
    const fragment = unchangedFragment ? previous.fragment : input.fragment;
    const changedDocument = !unchangedFragment || previous.attempt !== input.attempt;
    const initialHeight =
      frame.height?.fragment.deref()?.contents === fragment.contents
        ? frame.height.value
        : INLINE_VISUALIZATION_INITIAL_HEIGHT;
    if (changedDocument) {
      frame.runtime?.setActive(false);
      void frame.runtime?.dispose();
      frame.runtime = null;
    }
    if (
      !changedDocument &&
      previous.canExpand === input.canExpand &&
      previous.stateIdentity?.hostId === input.stateIdentity?.hostId &&
      previous.stateIdentity?.threadId === input.stateIdentity?.threadId &&
      previous.stateIdentity?.path === input.stateIdentity?.path
    )
      return;
    frame.snapshot = {
      ...previous,
      attempt: input.attempt,
      fragment,
      stateIdentity: input.stateIdentity,
      canExpand: input.canExpand,
      initialHeight,
      documentRevision: previous.documentRevision + (changedDocument ? 1 : 0),
    };
    emit(frame);
  };
  const requireBinding = (id: string) => {
    const frame = frames.get(id);
    if (!frame?.binding || !active(frame)) throw new Error("The conversation is unavailable");
    return frame.binding;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    windowLeases = 0;
    windowGeneration += 1;
    standby.dispose();
    frames.forEach(release);
    surfaces.clear();
    resumes.clear();
    listeners.clear();
    parking = null;
  };
  return {
    startStandby: (container: HTMLElement, locale: string) => {
      if (disposed) throw new Error("The visualization window has closed");
      return standby.start(container, locale);
    },
    claimStandby: (locale: string) => (disposed ? null : standby.claim(locale)),
    acquireWindow: () => {
      if (disposed) throw new Error("The visualization window has closed");
      windowLeases += 1;
      windowGeneration += 1;
      let released = false;
      return () => {
        if (released || disposed) return;
        released = true;
        windowLeases -= 1;
        const generation = ++windowGeneration;
        platform.schedule(() => {
          if (!windowLeases && generation === windowGeneration) dispose();
        });
      };
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readIds: () => ids,
    subscribeFrame: (id: string, listener: () => void) => {
      const frame = frames.get(id);
      frame?.listeners.add(listener);
      return () => frame?.listeners.delete(listener);
    },
    readFrame: (id: string) => frames.get(id)?.snapshot ?? null,
    setParking: (element: HTMLElement | null) => {
      parking = element;
      if (element) frames.forEach(place);
    },
    // Selecting a parked Thread may precede its asynchronous anchor restoration.
    setSurface: (surfaceId: string, hostId: string | null, threadId: string | null) => {
      surfaces.set(surfaceId, hostId && threadId ? threadKey(hostId, threadId) : null);
      for (const frame of frames.values()) {
        if (frame.snapshot.identity.surfaceId !== surfaceId) continue;
        place(frame);
        releaseIfHistoryInvalidated(frame);
      }
    },
    bind: (
      input: InlineVisualizationFrameInput,
      anchor: HTMLElement,
    ): InlineVisualizationFrameBinding => {
      if (disposed) throw new Error("The visualization window has closed");
      const key = inlineVisualizationFrameKey(input.identity);
      let frame = [...(byOccurrence.get(key) ?? [])]
        .map((id) => frames.get(id)!)
        .find((candidate) => !candidate.binding?.anchor.isConnected);
      if (!frame) {
        const id = platform.createId();
        frame = {
          key,
          listeners: new Set(),
          binding: null,
          runtime: null,
          height: null,
          snapshot: {
            id,
            identity: input.identity,
            container: platform.createContainer(),
            fragment: input.fragment,
            stateIdentity: input.stateIdentity,
            documentRevision: 0,
            attempt: input.attempt,
            initialHeight: INLINE_VISUALIZATION_INITIAL_HEIGHT,
            active: false,
            canExpand: input.canExpand,
          },
        };
        frames.set(id, frame);
        const occurrences = byOccurrence.get(key) ?? new Set();
        occurrences.add(id);
        byOccurrence.set(key, occurrences);
        emitList();
      }
      frame.runtime?.setActive(false);
      update(frame, input);
      const binding: Binding = { frameId: frame.snapshot.id, token: Symbol(), anchor, input };
      frame.binding = binding;
      place(frame);
      return binding;
    },
    updateBinding: (
      binding: InlineVisualizationFrameBinding,
      input: InlineVisualizationFrameInput,
    ) => {
      const frame = frames.get(binding.frameId);
      if (frame?.binding?.token !== binding.token) return;
      frame.binding.input = input;
      update(frame, input);
    },
    unbind: (binding: InlineVisualizationFrameBinding) => {
      const frame = frames.get(binding.frameId);
      if (frame?.binding?.token !== binding.token) return;
      frame.binding = null;
      place(frame);
      platform.schedule(() => releaseIfUnused(frame));
    },
    readPlaceholder: (identity: InlineVisualizationFrameIdentity) =>
      [...(byOccurrence.get(inlineVisualizationFrameKey(identity)) ?? [])]
        .map((id) => frames.get(id)?.snapshot.fragment)
        .find((fragment) => fragment !== undefined),
    attachRuntime: (id: string, runtime: InlineVisualizationRuntime) => {
      const frame = frames.get(id);
      if (!frame) {
        void runtime.dispose();
        return () => {};
      }
      frame.runtime = runtime;
      runtime.setActive(active(frame));
      return () => {
        if (frame.runtime !== runtime) return;
        frame.runtime = null;
        void runtime.dispose();
      };
    },
    acceptHeight: (id: string, revision: number, height: number) => {
      const frame = frames.get(id);
      const parsed = parseInlineVisualizationHeight(height);
      if (
        !frame ||
        parsed === null ||
        frame.snapshot.documentRevision !== revision ||
        !active(frame)
      )
        return;
      frame.height = { fragment: new WeakRef(frame.snapshot.fragment), value: parsed };
      if (parsed === frame.snapshot.initialHeight) return;
      frame.snapshot = { ...frame.snapshot, initialHeight: parsed };
      emit(frame);
    },
    isActive: (id: string) => {
      const frame = frames.get(id);
      return frame !== undefined && active(frame);
    },
    reportResumeState: (
      hostId: string,
      threadId: string,
      state: CodexConversationResumeState | null,
    ) => {
      resumes.set(threadKey(hostId, threadId), state);
      if (state !== null && state !== "needs_resume") return;
      for (const frame of frames.values()) {
        const identity = frame.snapshot.identity;
        if (identity.hostId !== hostId || identity.threadId !== threadId) continue;
        releaseIfHistoryInvalidated(frame);
      }
    },
    retry: (id: string) => requireBinding(id).input.retry(),
    followUp: (id: string, message: Parameters<InlineVisualizationFollowUpHandler>[0]) => {
      const send = requireBinding(id).input.followUp;
      if (!send) throw new Error("The conversation is unavailable");
      return send(message);
    },
    submitAnnotations: (
      id: string,
      message: Parameters<InlineVisualizationAnnotationSubmitHandler>[0],
    ) => {
      const submit = requireBinding(id).input.submitAnnotations;
      if (!submit) throw new Error("The conversation is unavailable");
      return submit(message);
    },
    releaseThread: (hostId: string, threadId: string) => {
      for (const frame of [...frames.values()]) {
        const identity = frame.snapshot.identity;
        if (identity.hostId === hostId && identity.threadId === threadId) release(frame);
      }
      resumes.delete(threadKey(hostId, threadId));
    },
    dispose,
  };
}

export type InlineVisualizationFrameOwner = ReturnType<typeof createInlineVisualizationFrameOwner>;
