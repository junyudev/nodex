import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Session, WebContents, WebPreferences } from "electron";
import { VISUAL_PARTITION_PREFIX } from "../../shared/visual/bridge";
import { VISUAL_LIMITS } from "../../shared/visual/contract";
import { WebContentsDestructionSubscriptions } from "../platform/electron/WebContentsDestructionSubscriptions";
import { prepareVisualGuest, type VisualGuest } from "./VisualGuest";

type Owner = { entries: Map<string, Admission>; pending: number; dispose: () => void };
interface Admission {
  guest: VisualGuest;
  state: "available" | "claimed" | "attached";
  stopObserving?: () => void;
}
const handlesPartition = (partition: string | undefined) =>
  partition?.startsWith(VISUAL_PARTITION_PREFIX) ?? false;

const make = Effect.gen(function* () {
  const destruction = yield* WebContentsDestructionSubscriptions;
  let closed = false;
  const owners = new Map<WebContents, Owner>();
  const sessions = new WeakSet<Session>();
  const ownerFor = (contents: WebContents) => {
    const previous = owners.get(contents);
    if (previous) return previous;
    const owner: Owner = {
      entries: new Map(),
      pending: 0,
      dispose: () => {
        if (!owners.delete(contents)) return;
        releaseDestruction();
        contents.removeListener("render-process-gone", owner.dispose);
        contents.removeListener("did-start-navigation", navigation);
        for (const entry of owner.entries.values()) {
          entry.stopObserving?.();
          entry.guest.close();
        }
        owner.entries.clear();
      },
    };
    const navigation = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame && !event.isSameDocument) owner.dispose();
    };
    const releaseDestruction = destruction.subscribe(contents, owner.dispose);
    contents.on("render-process-gone", owner.dispose);
    contents.on("did-start-navigation", navigation);
    owners.set(contents, owner);
    return owner;
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      for (const owner of owners.values()) owner.dispose();
    }),
  );
  return {
    handlesPartition,
    admit: (contents: WebContents) =>
      Effect.gen(function* () {
        if (closed || contents.isDestroyed()) return null;
        const owner = ownerFor(contents);
        if (owner.entries.size + owner.pending >= VISUAL_LIMITS.liveGuests) return null;
        owner.pending++;
        const guest = yield* prepareVisualGuest().pipe(
          Effect.ensuring(
            Effect.sync(() => {
              owner.pending--;
            }),
          ),
        );
        if (owners.get(contents) !== owner || contents.isDestroyed()) {
          guest.close();
          return null;
        }
        sessions.add(guest.session);
        owner.entries.set(guest.grant.grant, { guest, state: "available" });
        return guest.grant;
      }),
    willAttach: (
      owner: WebContents,
      event: Electron.Event,
      preferences: WebPreferences,
      params: { src?: string; partition?: string; allowpopups?: string },
    ) => {
      const grant = params.partition?.slice(VISUAL_PARTITION_PREFIX.length) ?? "";
      const admission = owners.get(owner)?.entries.get(grant);
      if (
        !admission ||
        admission.state !== "available" ||
        admission.guest.grant.url !== params.src
      ) {
        event.preventDefault();
        return;
      }
      delete params.allowpopups;
      admission.state = "claimed";
      admission.guest.preferences(preferences, params);
    },
    didAttach: (owner: WebContents, contents: WebContents) => {
      if (!sessions.has(contents.session)) return false;
      const entries = owners.get(owner)?.entries;
      const admission =
        entries &&
        [...entries.values()].find(
          (entry) => entry.state === "claimed" && entry.guest.session === contents.session,
        );
      if (!entries || !admission) {
        contents.close();
        return true;
      }
      admission.state = "attached";
      admission.guest.bind(contents);
      admission.stopObserving = destruction.subscribe(contents, () => {
        entries.delete(admission.guest.grant.grant);
        admission.guest.destroyed();
      });
      return true;
    },
    get: (contents: WebContents, grant: string) => {
      const entry = owners.get(contents)?.entries.get(grant);
      return entry?.state === "attached" ? entry.guest : undefined;
    },
    release: (contents: WebContents, grant: string) => {
      const entries = owners.get(contents)?.entries;
      const entry = entries?.get(grant);
      if (!entry) return false;
      entries?.delete(grant);
      entry.stopObserving?.();
      entry.guest.close();
      return true;
    },
  };
});

export class VisualGuestHost extends Context.Service<
  VisualGuestHost,
  Effect.Success<typeof make>
>()("nodex/main/visual/VisualGuestHost") {}
export const visualGuestHostLive = Layer.effect(VisualGuestHost, make).pipe(
  Layer.provide(WebContentsDestructionSubscriptions.live),
);
