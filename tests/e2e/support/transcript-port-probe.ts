import type { Page } from "@playwright/test";

export interface TranscriptPortEvidence {
  readonly channels: number;
  readonly posted: number;
  readonly sampleMessages: number;
  readonly closed: number;
  readonly observerErrors: number;
  readonly normalizedChannels: number;
  readonly residentItemCount: number;
  readonly residentItemIds: readonly string[];
  readonly pressureItemIds: string[];
  readonly pressureSlotItemIds: string[];
  readonly maxPressureItemCount: number;
  readonly turnStatuses: Readonly<Record<string, string>>;
  readonly turnAddressStatuses: readonly {
    readonly entityKey: string;
    readonly turnId: string | null;
    readonly status: string;
  }[];
  readonly runtimeStatusObservations: readonly string[];
  readonly resumeStates: readonly (string | null)[];
  readonly resetFrames: number;
  readonly structureChanges: number;
  readonly evictionFrame: TranscriptEvictionFrame | null;
  readonly anchorReloadFrame: TranscriptEvictionFrame | null;
  readonly pressureCommitFrames: readonly TranscriptPressureCommitFrame[];
  readonly releasedIdleObservation: {
    readonly maxNormalizedChannels: number;
    readonly maxResidentItemCount: number;
  } | null;
}

export interface TranscriptEvictionFrame {
  readonly residentItemCount: number;
  readonly pressureItemIds: readonly string[];
  readonly pressureSlotItemIds: readonly string[];
}

export interface TranscriptPressureCommitFrame {
  readonly type: string;
  readonly rawCount: number;
  readonly slotCount: number;
  readonly uniqueRawCount: number;
  readonly uniqueSlotCount: number;
  readonly head: string | null;
  readonly slotHead: string | null;
}

/** Passive production-port observation retains identities only, without adding a viewer. */
export async function installTranscriptPortProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counts = {
      channels: 0,
      posted: 0,
      sampleMessages: 0,
      closed: 0,
      observerErrors: 0,
      maxPressureItemCount: 0,
      runtimeStatusObservations: [] as string[],
      resetFrames: 0,
      structureChanges: 0,
    };
    const channels = new Set<{
      normalized: boolean;
      items: Map<string, string>;
      staged: Map<string, string> | null;
      slots: Map<string, string[]>;
      stagedSlots: Map<string, string[]> | null;
      turns: Map<string, { turnId: string | null; status: string }>;
      stagedTurns: Map<string, { turnId: string | null; status: string }> | null;
      evictionFrame: TranscriptEvictionFrame | null;
      anchorReloadFrame: TranscriptEvictionFrame | null;
      pressureCommitFrames: TranscriptPressureCommitFrame[];
      resumeState: string | null;
      stagedResumeState: string | null;
    }>();
    let releasedIdleObservation: {
      maxNormalizedChannels: number;
      maxResidentItemCount: number;
    } | null = null;
    const observeReleasedIdle = () => {
      if (!releasedIdleObservation) return;
      const active = [...channels].filter((channel) => channel.normalized);
      releasedIdleObservation.maxNormalizedChannels = Math.max(
        releasedIdleObservation.maxNormalizedChannels,
        active.length,
      );
      releasedIdleObservation.maxResidentItemCount = Math.max(
        releasedIdleObservation.maxResidentItemCount,
        active.reduce((total, channel) => total + channel.items.size, 0),
      );
    };
    (
      window as typeof window & { __beginTranscriptReleasedIdleObservation: () => void }
    ).__beginTranscriptReleasedIdleObservation = () => {
      releasedIdleObservation = { maxNormalizedChannels: 0, maxResidentItemCount: 0 };
      observeReleasedIdle();
    };
    const unwrapArray = (value: unknown): unknown[] =>
      Array.isArray(value) && value.length === 1 && Array.isArray(value[0])
        ? value[0]
        : Array.isArray(value)
          ? value
          : [];
    const object = (value: unknown): Record<string, unknown> | null =>
      value != null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const Original = window.MessageChannel;
    window.MessageChannel = class extends Original {
      constructor() {
        super();
        counts.channels++;
        const channel = {
          normalized: false,
          items: new Map<string, string>(),
          staged: null as Map<string, string> | null,
          slots: new Map<string, string[]>(),
          stagedSlots: null as Map<string, string[]> | null,
          turns: new Map<string, { turnId: string | null; status: string }>(),
          stagedTurns: null as Map<string, { turnId: string | null; status: string }> | null,
          evictionFrame: null as TranscriptEvictionFrame | null,
          anchorReloadFrame: null as TranscriptEvictionFrame | null,
          pressureCommitFrames: [] as TranscriptPressureCommitFrame[],
          resumeState: null as string | null,
          stagedResumeState: null as string | null,
        };
        channels.add(channel);
        const installItems = (target: Map<string, string>, value: unknown) => {
          for (const [address, item] of Object.entries(object(value) ?? {})) {
            const id = object(item)?.id;
            if (typeof id === "string") target.set(address, id);
          }
        };
        const installSlots = (target: Map<string, string[]>, value: unknown) => {
          for (const [key, turn] of Object.entries(object(value) ?? {})) {
            const entries = unwrapArray(object(object(turn)?.itemSlots)?.entries);
            target.set(
              key,
              entries.flatMap((entry) =>
                typeof object(entry)?.itemId === "string" ? [object(entry)!.itemId as string] : [],
              ),
            );
          }
        };
        const installTurns = (
          target: Map<string, { turnId: string | null; status: string }>,
          value: unknown,
        ) => {
          for (const [key, turn] of Object.entries(object(value) ?? {})) {
            const details = object(object(turn)?.details);
            const status = details?.status;
            if (typeof status === "string")
              target.set(key, {
                turnId: typeof details?.turnId === "string" ? details.turnId : null,
                status,
              });
          }
        };
        const observeEvent = (event: Record<string, unknown>) => {
          const type = event.type;
          const snapshot = object(event.value);
          if (type === "reset" && (event.value === null || snapshot?.itemsByKey)) {
            channel.normalized = true;
            counts.resetFrames++;
            channel.resumeState =
              typeof snapshot?.resumeState === "string" ? snapshot.resumeState : null;
            channel.items.clear();
            channel.slots.clear();
            channel.turns.clear();
            installItems(channel.items, snapshot?.itemsByKey);
            installSlots(channel.slots, snapshot?.turnsByKey);
            installTurns(channel.turns, snapshot?.turnsByKey);
          } else if (type === "reset-start" && snapshot?.turnEntityKeys) {
            channel.normalized = true;
            counts.resetFrames++;
            channel.stagedResumeState =
              typeof snapshot.resumeState === "string" ? snapshot.resumeState : null;
            channel.staged = new Map();
            channel.stagedSlots = new Map();
            channel.stagedTurns = new Map();
          } else if (type === "reset-part" && event.itemsByKey) {
            channel.normalized = true;
            if (channel.staged) installItems(channel.staged, event.itemsByKey);
            if (channel.stagedSlots) installSlots(channel.stagedSlots, event.turnsByKey);
            if (channel.stagedTurns) installTurns(channel.stagedTurns, event.turnsByKey);
          } else if (type === "reset-commit" && channel.staged) {
            channel.items = channel.staged;
            channel.staged = null;
            channel.slots = channel.stagedSlots ?? new Map();
            channel.stagedSlots = null;
            channel.turns = channel.stagedTurns ?? new Map();
            channel.stagedTurns = null;
            channel.resumeState = channel.stagedResumeState;
            channel.stagedResumeState = null;
          } else if (type === "changes") {
            for (const value of unwrapArray(event.changes)) {
              const change = object(value);
              if (change?.type === "history") {
                if (typeof change.resumeState === "string")
                  channel.resumeState = change.resumeState;
                continue;
              }
              if (change?.type === "structure") {
                counts.structureChanges++;
                continue;
              }
              const key = object(change?.key);
              if (typeof key?.entityKey !== "string") continue;
              if (change?.type === "item" && typeof key.itemId === "string") {
                channel.normalized = true;
                const address = JSON.stringify([key.entityKey, key.itemId]);
                if (change.value === null) channel.items.delete(address);
                else channel.items.set(address, key.itemId);
              } else if (change?.type === "turn") {
                const details = object(change.details);
                const status = details?.status;
                if (typeof status === "string")
                  channel.turns.set(key.entityKey, {
                    turnId: typeof details?.turnId === "string" ? details.turnId : null,
                    status,
                  });
              } else if (change?.type === "item-slots") {
                channel.slots.set(
                  key.entityKey,
                  unwrapArray(object(change.slots)?.entries).flatMap((entry) =>
                    typeof object(entry)?.itemId === "string"
                      ? [object(entry)!.itemId as string]
                      : [],
                  ),
                );
              } else if (change?.type === "item-slots-append") {
                const previous = channel.slots.get(key.entityKey) ?? [];
                channel.slots.set(key.entityKey, [
                  ...previous,
                  ...unwrapArray(change.entries).flatMap((entry) =>
                    typeof object(entry)?.itemId === "string"
                      ? [object(entry)!.itemId as string]
                      : [],
                  ),
                ]);
              } else if (change?.type === "remove-turn") {
                channel.slots.delete(key.entityKey);
                channel.turns.delete(key.entityKey);
                for (const address of channel.items.keys())
                  if (JSON.parse(address)[0] === key.entityKey) channel.items.delete(address);
              }
            }
          } else return;
          counts.maxPressureItemCount = Math.max(
            counts.maxPressureItemCount,
            [...channel.items.values()].filter((id) => id.startsWith("pressure-command-")).length,
          );
          const pressureIds = [...channel.items.values()].filter((id) =>
            id.startsWith("pressure-command-"),
          );
          if (
            counts.maxPressureItemCount === 1001 &&
            channel.items.size === 500 &&
            pressureIds.length === 499 &&
            !pressureIds.includes("pressure-command-0000")
          ) {
            channel.evictionFrame = {
              residentItemCount: channel.items.size,
              pressureItemIds: pressureIds.sort(),
              pressureSlotItemIds: [...channel.slots.values()]
                .flat()
                .filter((id) => id.startsWith("pressure-command-"))
                .sort(),
            };
          }
          // Retain the first committed anchor page even if its visible gap loads more pages.
          if (
            channel.evictionFrame &&
            !channel.anchorReloadFrame &&
            pressureIds.length === 599 &&
            pressureIds.includes("pressure-command-0402") &&
            !pressureIds.includes("pressure-command-0401")
          ) {
            channel.anchorReloadFrame = {
              residentItemCount: channel.items.size,
              pressureItemIds: pressureIds.sort(),
              pressureSlotItemIds: [...channel.slots.values()]
                .flat()
                .filter((id) => id.startsWith("pressure-command-"))
                .sort(),
            };
          }
          if (channel.evictionFrame && type !== "reset-start" && type !== "reset-part") {
            const slotIds = [...channel.slots.values()]
              .flat()
              .filter((id) => id.startsWith("pressure-command-"))
              .sort();
            const frame = {
              type: String(type),
              rawCount: pressureIds.length,
              slotCount: slotIds.length,
              uniqueRawCount: new Set(pressureIds).size,
              uniqueSlotCount: new Set(slotIds).size,
              head: pressureIds.sort()[0] ?? null,
              slotHead: slotIds[0] ?? null,
            };
            const previous = channel.pressureCommitFrames.at(-1);
            if (
              channel.pressureCommitFrames.length < 32 &&
              (!previous ||
                previous.rawCount !== frame.rawCount ||
                previous.slotCount !== frame.slotCount ||
                previous.head !== frame.head ||
                previous.slotHead !== frame.slotHead)
            )
              channel.pressureCommitFrames.push(frame);
          }
          observeReleasedIdle();
        };
        const visit = (value: unknown, seen: Set<object>) => {
          if (value === null || typeof value !== "object" || seen.has(value)) return;
          seen.add(value);
          const event = object(value);
          const runtimeStatus = object(event?.threadRuntimeStatus)?.type;
          const nativeStatus =
            event?.method === "thread/status/changed"
              ? object(object(event.params)?.status)?.type
              : undefined;
          const patchStatus =
            event?.op === "replace" && unwrapArray(event.path)[0] === "threadRuntimeStatus"
              ? object(event.value)?.type
              : undefined;
          const observedStatus = nativeStatus ?? patchStatus ?? runtimeStatus;
          if (typeof observedStatus === "string") {
            counts.runtimeStatusObservations.push(observedStatus);
            if (counts.runtimeStatusObservations.length > 16)
              counts.runtimeStatusObservations.shift();
          }
          if (event?.type) observeEvent(event);
          for (const child of Object.values(value)) visit(child, seen);
        };
        for (const port of [this.port1, this.port2]) {
          const post = port.postMessage.bind(port);
          port.postMessage = ((...args: unknown[]) => {
            const result = Reflect.apply(post, port, args);
            counts.posted++;
            try {
              if ((JSON.stringify(args[0]) ?? "").includes("sample-")) counts.sampleMessages++;
              visit(args[0], new Set());
            } catch {
              counts.observerErrors++;
            }
            return result;
          }) as MessagePort["postMessage"];
          const close = port.close.bind(port);
          let closed = false;
          port.close = () => {
            if (!closed) counts.closed++;
            closed = true;
            channels.delete(channel);
            observeReleasedIdle();
            close();
          };
        }
      }
    };
    (
      window as typeof window & { __readTranscriptPortEvidence: () => unknown }
    ).__readTranscriptPortEvidence = () => {
      const active = [...channels].filter((channel) => channel.normalized);
      return {
        ...counts,
        releasedIdleObservation,
        normalizedChannels: active.length,
        resumeStates: active.map((channel) => channel.resumeState),
        residentItemCount: active.reduce((total, channel) => total + channel.items.size, 0),
        residentItemIds: active.flatMap((channel) => [...channel.items.values()]).sort(),
        turnStatuses: Object.fromEntries(
          active.flatMap((channel) =>
            [...channel.turns].map(([entityKey, turn]) => [turn.turnId ?? entityKey, turn.status]),
          ),
        ),
        turnAddressStatuses: active.flatMap((channel) =>
          [...channel.turns].map(([entityKey, turn]) => ({ entityKey, ...turn })),
        ),
        anchorReloadFrame:
          active.find((channel) => channel.anchorReloadFrame)?.anchorReloadFrame ?? null,
        pressureCommitFrames: active.flatMap((channel) => channel.pressureCommitFrames),
        evictionFrame: active.find((channel) => channel.evictionFrame)?.evictionFrame ?? null,
        pressureItemIds: active
          .flatMap((channel) =>
            [...channel.items.values()].filter((id) => id.startsWith("pressure-command-")),
          )
          .sort(),
        pressureSlotItemIds: active
          .flatMap((channel) =>
            [...channel.slots.values()].flat().filter((id) => id.startsWith("pressure-command-")),
          )
          .sort(),
      };
    };
  });
}

export const readTranscriptPortEvidence = async (page: Page): Promise<TranscriptPortEvidence> =>
  await page.evaluate(() =>
    (
      window as typeof window & { __readTranscriptPortEvidence: () => TranscriptPortEvidence }
    ).__readTranscriptPortEvidence(),
  );

export const beginTranscriptReleasedIdleObservation = async (page: Page): Promise<void> =>
  await page.evaluate(() =>
    (
      window as typeof window & { __beginTranscriptReleasedIdleObservation: () => void }
    ).__beginTranscriptReleasedIdleObservation(),
  );
