import type { ChatActivity, ChatList, ChatSummary } from "@nodex/mobile-protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { z } from "zod";
import { persistedAtom, usePersistedAtomValue, useSetPersistedAtom } from "@/lib/maitai";
import { fileSource } from "../../../shared/file-resources";
import { inboxDraftSchema } from "../inbox/inbox-capture-state";
import { companion, miniHost, MiniCompanionError } from "./mini-host";
import {
  miniCards,
  miniStartSettled,
  type MiniCard,
  type MiniDismissal,
  type MiniStart,
} from "./mini-model";

const CHATS_KEY = ["mini", "chats"] as const;
const INBOX_KEY = ["mini", "inbox"] as const;
const PROJECTS_KEY = ["mini", "projects"] as const;
const RUNNING = new Set<ChatSummary["status"]>(["running", "background"]);
/** Bounded so a long-lived Profile never grows the set without end. */
const DISMISSED_LIMIT = 200;

const dismissedAtom = persistedAtom({
  debugLabel: "mini-dismissed-cards",
  storageKey: "mini-dismissed-cards-v2",
  defaultValue: [] as readonly MiniDismissal[],
  hydration: "eager",
  synchronization: "same-window",
  writeFailure: "retain-and-error",
  decode: (value: unknown) =>
    z
      .array(z.object({ key: z.string(), version: z.string() }))
      .max(DISMISSED_LIMIT)
      .parse(value),
});

/** Mini's outbox of chats to start: written before the draft is cleared, so none is ever lost. */
const startsAtom = persistedAtom({
  debugLabel: "mini-starts",
  storageKey: "mini-starts-v1",
  defaultValue: [] as readonly MiniStart[],
  hydration: "eager",
  synchronization: "same-window",
  writeFailure: "retain-and-error",
  decode: (value: unknown): readonly MiniStart[] =>
    z
      .array(
        z.object({
          sessionId: z.string().min(1),
          launchId: z.string().min(1),
          messageId: z.string().min(1),
          projectId: z.string().nullable(),
          project: z.string().nullable(),
          draft: inboxDraftSchema,
          startedAt: z.number(),
          status: z.enum(["sending", "sent", "failed"]),
          sentAt: z.number().nullable(),
          error: z.string().nullable(),
        }),
      )
      .parse(value),
});

/** Sends a start to the Host: null once the Host has the chat, else why it did not take it. */
const sendStart = (start: MiniStart): Promise<{ readonly error: string | null } | null> =>
  companion("chats.start", {
    sessionId: start.sessionId,
    launchId: start.launchId,
    messageId: start.messageId,
    projectId: start.projectId,
    text: start.draft.text.trim(),
    fileRefs: start.draft.images.map((image) => fileSource(image.fileId)),
    agent: null,
    location: "local",
  }).then(
    () => null,
    (error: unknown) => ({ error: error instanceof MiniCompanionError ? error.message : null }),
  );

/**
 * Reads what Mini shows from the companion session and keeps it live from its events, and owns the
 * chats Mini starts: each is kept until the chat list settles it, and one the Host has not
 * answered is sent again with the same identities when Mini comes back.
 */
export function useMiniActivity() {
  const queryClient = useQueryClient();
  const chats = useQuery({
    queryKey: CHATS_KEY,
    queryFn: () => companion("chats.list", { first: 50 }),
    staleTime: 30_000,
  });
  const inbox = useQuery({
    queryKey: INBOX_KEY,
    queryFn: () =>
      companion("inbox.window", { scope: { kind: "all" }, filter: "inbox", first: 100 }),
    staleTime: 30_000,
  });
  const projects = useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: () => companion("projects.list", {}),
    staleTime: 60_000,
  });
  const dismissed = usePersistedAtomValue(dismissedAtom).value;
  const writeDismissed = useSetPersistedAtom(dismissedAtom);
  const starts = usePersistedAtomValue(startsAtom);
  const writeStarts = useSetPersistedAtom(startsAtom);
  const updateStart = (sessionId: string, change: (start: MiniStart) => MiniStart) =>
    writeStarts((current) =>
      current.map((start) => (start.sessionId === sessionId ? change(start) : start)),
    ).catch(() => undefined);

  const deliver = (start: MiniStart): Promise<unknown> =>
    sendStart(start).then((failure) =>
      failure
        ? updateStart(start.sessionId, (current) => ({
            ...current,
            status: "failed",
            error: failure.error,
          }))
        : updateStart(start.sessionId, (current) => ({
            ...current,
            status: "sent",
            sentAt: Date.now(),
            error: null,
          })).then(() => queryClient.invalidateQueries({ queryKey: CHATS_KEY })),
    );

  useEffect(
    () =>
      miniHost.onCompanionEvent((message) => {
        if (message.event === "changed") {
          const topics = new Set(message.data.topics);
          if (topics.has("chats")) void queryClient.invalidateQueries({ queryKey: CHATS_KEY });
          if (topics.has("inbox")) void queryClient.invalidateQueries({ queryKey: INBOX_KEY });
          if (topics.has("projects"))
            void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
          return;
        }
        if (message.event === "chat.activity") {
          // A chat's live status updates its row in place, and a new status, or a chat new to the
          // list, is read again; when it last changed stays the Host's to say, on that read.
          const activity: ChatActivity = message.data;
          let reread = true;
          queryClient.setQueryData<ChatList>(CHATS_KEY, (current) => {
            if (!current) return current;
            return {
              ...current,
              items: current.items.map((chat): ChatSummary => {
                if (chat.sessionId !== activity.sessionId) return chat;
                reread = chat.status !== activity.status;
                // A Run that just ended is unseen until the read says otherwise, so its card
                // turns to finished instead of leaving for a moment.
                const finished = RUNNING.has(chat.status) && activity.status === "idle";
                return { ...chat, ...activity, unread: chat.unread || finished };
              }),
            };
          });
          if (reread) void queryClient.invalidateQueries({ queryKey: CHATS_KEY });
        }
      }),
    [queryClient],
  );

  // Let go of starts the chat list has settled, whenever it is read or patched.
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        const [owner, name] = event.query.queryKey;
        if (event.type !== "updated" || owner !== CHATS_KEY[0] || name !== CHATS_KEY[1]) return;
        const list = event.query.state.data as ChatList | undefined;
        if (!list) return;
        const readAt = event.query.state.dataUpdatedAt;
        void writeStarts((current) => {
          const kept = current.filter((start) => !miniStartSettled(start, list.items, readAt));
          return kept.length === current.length ? current : kept;
        }).catch(() => undefined);
      }),
    [queryClient, writeStarts],
  );

  // A start sent just before Mini last closed may never have reached the Host; its identities make
  // sending it again safe.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || starts.status !== "ready") return;
    resumed.current = true;
    for (const start of starts.value) if (start.status === "sending") void deliver(start);
  });

  const projectNames = useMemo(
    () => new Map((projects.data?.projects ?? []).map((project) => [project.id, project.name])),
    [projects.data],
  );
  const cards = useMemo(
    () =>
      miniCards({
        chats: chats.data?.items ?? [],
        chatsReadAt: chats.dataUpdatedAt,
        inbox: inbox.data?.items ?? [],
        starts: starts.value,
        dismissed,
        projectName: (projectId) => projectNames.get(projectId) ?? null,
      }),
    [chats.data, chats.dataUpdatedAt, inbox.data, starts.value, dismissed, projectNames],
  );

  return {
    cards,
    /** Null until read, so a stored Project is never taken for one that is gone. */
    projects: projects.data?.projects ?? null,
    loaded: chats.isSuccess && inbox.isSuccess,
    dismiss: (card: MiniCard) => {
      if (card.kind === "starting") {
        void writeStarts((current) =>
          current.filter((start) => start.sessionId !== card.sessionId),
        ).catch(() => undefined);
        return;
      }
      void writeDismissed((current) =>
        [...current.filter((entry) => entry.key !== card.key), card]
          .slice(-DISMISSED_LIMIT)
          .map(({ key, version }) => ({ key, version })),
      ).catch(() => undefined);
      // Seeing a finished chat is reading it, as opening it would be.
      if (card.kind === "chat" && card.tone === "done")
        void companion("chat.markRead", { sessionId: card.sessionId }).catch(() => undefined);
    },
    /**
     * Starts a chat: the start is stored first, so the caller may clear its draft once this
     * resolves, then sent. Rejects, leaving nothing stored, when the start could not be stored.
     */
    start: async (start: MiniStart): Promise<void> => {
      await writeStarts((current) => [...current, start]);
      void deliver(start);
    },
    retryStart: (sessionId: string) => {
      const start = starts.value.find((candidate) => candidate.sessionId === sessionId);
      if (!start) return;
      void updateStart(sessionId, (current) => ({ ...current, status: "sending", error: null }));
      void deliver(start);
    },
    /** Takes a start that failed back out of the outbox, for its draft to return to the composer. */
    takeBackStart: async (sessionId: string): Promise<MiniStart | null> => {
      const start = starts.value.find((candidate) => candidate.sessionId === sessionId) ?? null;
      if (!start) return null;
      await writeStarts((current) => current.filter((entry) => entry.sessionId !== sessionId));
      return start;
    },
  };
}
