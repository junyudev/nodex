import { it } from "@effect/vitest";
import { expect } from "vitest";
import * as Effect from "effect/Effect";
import type { components } from "@nodex/core-protocol";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../main/agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../main/core-runtime/CoreModules";
import { FileExportRuntime } from "../main/library-application/FileExportRuntime";
import { LibraryModule } from "../main/library-application/LibraryModule";
import { ProjectWorkspace } from "../main/project-application/ProjectWorkspace";
import { fileSource } from "../shared/file-resources";
import type { ProjectSession } from "../shared/types";
import type { HeadlessHost } from "./HeadlessApplicationLive";
import { executeHostCommand } from "./HostCommands";
import { HostInvocation } from "./HostInvocation";
import { make, MemberMessageRefusal } from "./MemberMessages";
import { CodexGitProbe } from "../main/codex-application/CodexGitProbe";

/** The host's checkout of a Project is on its `main` branch. */
const gitProbe = {
  readPath: (_root: string, args: readonly string[]) =>
    Effect.succeed(args.includes("HEAD") && args[0] === "symbolic-ref" ? "main" : null),
} as unknown as CodexGitProbe["Service"];

const sessions: Record<string, Partial<ProjectSession>> = {
  chat: { id: "chat", archived: false, executionRef: { runtimeId: "runtime", threadId: "root" } },
  paused: {
    id: "paused",
    archived: false,
    executionRef: { runtimeId: "runtime", threadId: "root" },
  },
  archived: {
    id: "archived",
    archived: true,
    executionRef: { runtimeId: "runtime", threadId: "root" },
  },
};

it.effect("delivers each Member's message as a local chat would, with that Member's proof", () =>
  Effect.gen(function* () {
    const calls: { method: string; input: unknown; proof: string | null }[] = [];
    const reads: { fileId: string; proof: string | null }[] = [];
    const accepted = new Map<string, { fingerprint: string; sequence: number }>();
    let chatArchived = false;
    const library: Record<string, object> = {
      photo: { default_name: "photo.png", mime_type: "image/png", byte_length: 3, version: 2 },
      notes: { default_name: "notes.md", mime_type: "text/markdown", byte_length: 9, version: 1 },
    };
    const record = (method: string) => (input: unknown) =>
      Effect.flatMap(HostInvocation, (proof) =>
        Effect.sync(() => {
          calls.push({ method, input, proof });
          return { sequence: calls.length };
        }),
      );
    const messages = yield* make.pipe(
      Effect.provideService(AgentRuntimeApplication, {
        replayMessage: ({
          sessionId,
          messageId,
          fingerprint,
        }: {
          sessionId: string;
          messageId: string;
          fingerprint: string;
        }) =>
          Effect.gen(function* () {
            const receipt = accepted.get(`${sessionId}:${messageId}`);
            if (receipt && receipt.fingerprint !== fingerprint)
              return yield* new AgentRuntimeApplicationError({
                operation: "message-replay",
                message: "This message was already submitted with different content.",
                admissionRejected: true,
              });
            return receipt ?? null;
          }),
        sendMessage: (input: Parameters<AgentRuntimeApplication["Service"]["sendMessage"]>[0]) =>
          record("sendMessage")(input).pipe(
            Effect.tap((result) =>
              Effect.sync(() =>
                accepted.set(`${input.sessionId}:${input.message.messageId}`, {
                  fingerprint: input.messageFingerprint!,
                  sequence: result.sequence,
                }),
              ),
            ),
          ),
        queue: record("queue"),
        rewriteMessage: record("rewriteMessage"),
      } as unknown as AgentRuntimeApplication["Service"]),
      Effect.provideService(ProjectWorkspace, {
        getProjectSession: (id: string) =>
          Effect.succeed(
            id === "chat" && chatArchived
              ? { ...sessions.chat, archived: true }
              : ((sessions[id] as ProjectSession) ?? null),
          ),
      } as unknown as ProjectWorkspace["Service"]),
      Effect.provideService(CoreModules, {
        workspace: {
          read: (read: { target: { session_id: string } }) =>
            Effect.succeed({
              value: {
                kind: "effective_execution_hold",
                holds:
                  read.target.session_id === "paused"
                    ? [{ scope: { kind: "space" }, actor: "alice", revision: 1, paused_at: "now" }]
                    : [],
              },
            }),
        },
      } as unknown as CoreModules["Service"]),
      // Each attached Library File is read as the invoking Member, never with the host's authority.
      Effect.provideService(LibraryModule, {
        read: (_route: unknown, request: { read: { file_id: string } }) =>
          Effect.flatMap(HostInvocation, (proof) =>
            Effect.sync(() => {
              reads.push({ fileId: request.read.file_id, proof });
              return library[request.read.file_id]
                ? {
                    ok: true,
                    value: {
                      value: {
                        kind: "file_presentation",
                        value: library[request.read.file_id],
                      },
                    },
                  }
                : { ok: false, error: { code: "resource_not_found", message: "Missing" } };
            }),
          ),
      } as unknown as LibraryModule["Service"]),
      Effect.provideService(FileExportRuntime, {
        materialize: (_route: unknown, input: { fileId: string; version: number }) =>
          Effect.succeed(`/host/exports/${input.fileId}@${input.version}`),
      } as unknown as FileExportRuntime["Service"]),
      Effect.provideService(CodexGitProbe, gitProbe),
    );
    const host = { messages } as unknown as HeadlessHost["Service"];
    const relay = (operation: components["schemas"]["HostOperation"], input: unknown) =>
      executeHostCommand(host, {
        id: "call",
        credential: "alice-proof",
        call: { operation, input },
      });
    const message = { messageId: "m1", text: "Run the loop again" };
    const steerMessage = { ...message, messageId: "steer" };
    const queueMessage = { ...message, messageId: "queue" };

    yield* relay("session_message", { sessionId: "chat", message, delivery: "send" });
    yield* relay("session_message", {
      sessionId: "chat",
      message: steerMessage,
      delivery: "steer",
    });
    yield* relay("session_message", {
      sessionId: "chat",
      message: queueMessage,
      delivery: "queue",
    });
    yield* relay("session_queue", {
      sessionId: "chat",
      requestId: "r1",
      action: "reorder",
      orderedRunIds: ["a", "b"],
    });
    // Files any Device uploaded and the context it references travel with the same delivery.
    const context = { version: 1, records: [{ kind: "page", label: "Plan", payload: {} }] };
    const attached = {
      sessionId: "chat",
      message: {
        ...message,
        messageId: "with-files",
        fileRefs: [fileSource("photo"), fileSource("notes")],
        context,
      },
      delivery: "queue",
    };
    const original = yield* relay("session_message", attached);

    expect(calls).toEqual([
      {
        method: "sendMessage",
        input: { sessionId: "chat", message, mode: "auto", messageFingerprint: expect.any(String) },
        proof: "alice-proof",
      },
      {
        method: "sendMessage",
        input: {
          sessionId: "chat",
          message: steerMessage,
          mode: "steer",
          messageFingerprint: expect.any(String),
        },
        proof: "alice-proof",
      },
      {
        method: "sendMessage",
        input: {
          sessionId: "chat",
          message: queueMessage,
          mode: "queue",
          messageFingerprint: expect.any(String),
        },
        proof: "alice-proof",
      },
      {
        method: "queue",
        input: { sessionId: "chat", requestId: "r1", action: "reorder", orderedRunIds: ["a", "b"] },
        proof: "alice-proof",
      },
      {
        method: "sendMessage",
        input: {
          sessionId: "chat",
          message: { ...message, messageId: "with-files", context },
          mode: "queue",
          messageFingerprint: expect.any(String),
          resources: [
            {
              source: "/host/exports/photo@2",
              name: "photo.png",
              mimeType: "image/png",
              sizeBytes: 3,
            },
            {
              source: "/host/exports/notes@1",
              name: "notes.md",
              mimeType: "text/markdown",
              sizeBytes: 9,
            },
          ],
        },
        proof: "alice-proof",
      },
    ]);
    expect(reads).toEqual([
      { fileId: "photo", proof: "alice-proof" },
      { fileId: "notes", proof: "alice-proof" },
    ]);

    const refused = yield* relay("session_message", {
      sessionId: "archived",
      message,
      delivery: "send",
    }).pipe(Effect.flip);
    expect(refused).toBeInstanceOf(MemberMessageRefusal);
    expect(refused).toMatchObject({ message: "Restore this chat to continue it." });
    // A pause holds every Device's messages until the person resumes it.
    expect(
      yield* relay("session_message", { sessionId: "paused", message, delivery: "queue" }).pipe(
        Effect.flip,
      ),
    ).toMatchObject({ message: "Resume work to send." });
    // An edit rewinds to the Member's own message and carries what they attached again.
    yield* relay("session_rewrite_message", {
      sessionId: "chat",
      requestId: "edit",
      runId: "run",
      message: { ...message, messageId: "m2", fileRefs: [fileSource("notes")] },
    });
    expect(calls.at(-1)).toEqual({
      method: "rewriteMessage",
      input: {
        sessionId: "chat",
        requestId: "edit",
        runId: "run",
        message: { ...message, messageId: "m2" },
        resources: [
          {
            source: "/host/exports/notes@1",
            name: "notes.md",
            mimeType: "text/markdown",
            sizeBytes: 9,
          },
        ],
      },
      proof: "alice-proof",
    });
    // A file the Member cannot read, or any image bytes or path, never reaches the Runtime.
    expect(
      yield* relay("session_message", {
        sessionId: "chat",
        message: { ...message, messageId: "missing-file", fileRefs: [fileSource("elsewhere")] },
        delivery: "send",
      }).pipe(Effect.flip),
    ).toMatchObject({ message: "This file is unavailable." });
    const rich = yield* relay("session_message", {
      sessionId: "chat",
      message: { ...message, images: [{ source: "/Users/alice/photo.png" }] },
      delivery: "send",
    }).pipe(Effect.exit);
    expect(rich._tag).toBe("Failure");
    chatArchived = true;
    delete library.photo;
    expect(yield* relay("session_message", attached)).toEqual(original);
    const changed = yield* relay("session_message", {
      ...attached,
      message: { ...attached.message, text: "A different prompt" },
    }).pipe(Effect.flip);
    expect(changed).toBeInstanceOf(MemberMessageRefusal);
    expect(changed).toMatchObject({
      message: "This message was already submitted with different content.",
    });
    expect(calls).toHaveLength(6);
    expect(reads.filter(({ fileId }) => fileId === "photo")).toHaveLength(1);
  }),
);

it.effect(
  "starts a Member's new chat where the host runs it, delivered once like the Inbox's",
  () =>
    Effect.gen(function* () {
      const launches: { input: Record<string, unknown>; proof: string | null }[] = [];
      const admitted = new Map<string, { sessionId: string; threadId: string }>();
      let paused = false;
      let heldProject: string | null = null;
      const messages = yield* make.pipe(
        Effect.provideService(AgentRuntimeApplication, {
          // The host's tasks directory for a chat without a Project, its checkout for a Project.
          executionWorkspace: (projectId: string | null) =>
            Effect.succeed(
              paused || projectId === "gone"
                ? { available: false, reason: "Choose an active Project to run this task" }
                : {
                    available: true,
                    workspaceRoot: projectId ? `/host/projects/${projectId}` : "/host/tasks",
                    sourceRoots: [],
                  },
            ),
          replayMessage: ({ launchId }: { launchId: string }) =>
            Effect.sync(() => admitted.get(launchId) ?? null),
          launch: (input: Record<string, unknown>) =>
            Effect.flatMap(HostInvocation, (proof) =>
              Effect.sync(() => {
                launches.push({ input, proof });
                const sessionId = input.sessionId as string;
                const receipt = { sessionId, threadId: `thread:${sessionId}` };
                admitted.set(input.launchId as string, receipt);
                return receipt;
              }),
            ),
        } as unknown as AgentRuntimeApplication["Service"]),
        Effect.provideService(ProjectWorkspace, {} as unknown as ProjectWorkspace["Service"]),
        Effect.provideService(CoreModules, {
          workspace: {
            read: ({ after_key }: { after_key: string | null }) =>
              Effect.succeed({
                value: {
                  kind: "execution_holds",
                  holds:
                    after_key === "space:"
                      ? paused
                        ? [{ scope: { kind: "space" } }]
                        : []
                      : heldProject
                        ? [{ scope: { kind: "project", project_id: heldProject } }]
                        : [],
                },
              }),
          },
        } as unknown as CoreModules["Service"]),
        Effect.provideService(LibraryModule, {
          read: () =>
            Effect.succeed({
              ok: true,
              value: {
                value: {
                  kind: "file_presentation",
                  value: {
                    default_name: "plan.md",
                    mime_type: "text/markdown",
                    byte_length: 4,
                    version: 1,
                  },
                },
              },
            }),
        } as unknown as LibraryModule["Service"]),
        Effect.provideService(FileExportRuntime, {
          materialize: (_route: unknown, input: { fileId: string }) =>
            Effect.succeed(`/host/exports/${input.fileId}`),
        } as unknown as FileExportRuntime["Service"]),
        Effect.provideService(CodexGitProbe, gitProbe),
      );
      const host = { messages } as unknown as HeadlessHost["Service"];
      const relay = (input: unknown) =>
        executeHostCommand(host, {
          id: "call",
          credential: "bob-proof",
          call: { operation: "session_start", input },
        });
      const start = {
        sessionId: "draft",
        launchId: "launch",
        acceptedAt: 1,
        projectId: null,
        title: "Summarize the plan",
        modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
        interactionMode: "default",
        message: { messageId: "m1", text: "Summarize the plan", fileRefs: [fileSource("plan")] },
      };
      expect(yield* relay(start)).toEqual({
        sessionId: "draft",
        threadId: "thread:draft",
        projectId: null,
      });
      // The starter's proof creates the chat; their Library File is read as a private copy.
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({
        proof: "bob-proof",
        input: {
          sessionId: "draft",
          projectId: null,
          runInTarget: "localProject",
          message: { messageId: "m1", text: "Summarize the plan" },
          resources: [{ source: "/host/exports/plan", name: "plan.md" }],
        },
      });
      // A retry of the same start finds the chat already started rather than launching it again.
      paused = true;
      expect(yield* relay(start)).toEqual({
        sessionId: "draft",
        threadId: "thread:draft",
        projectId: null,
      });
      expect(
        yield* relay({ ...start, sessionId: "space-held", launchId: "space-held" }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ message: "Resume work to start this chat." });
      paused = false;
      heldProject = "crew";
      expect(
        yield* relay({
          ...start,
          sessionId: "project-held",
          launchId: "project-held",
          projectId: "crew",
        }).pipe(Effect.flip),
      ).toMatchObject({ message: "Resume work to start this chat." });
      heldProject = null;
      expect(launches).toHaveLength(1);
      // A worktree starts from the branch the host's checkout of the Project is on.
      yield* relay({
        ...start,
        sessionId: "project-chat",
        launchId: "project-launch",
        projectId: "crew",
        runInTarget: "newWorktree",
      });
      expect(launches.at(-1)?.input).toMatchObject({
        projectId: "crew",
        runInTarget: "newWorktree",
        worktreeStartingState: { type: "branch", branchName: "main" },
      });
      // The host's refusal reads as a product sentence, before anything starts.
      const refused = yield* relay({
        ...start,
        sessionId: "gone",
        launchId: "gone",
        projectId: "gone",
      }).pipe(Effect.flip);
      expect(refused).toMatchObject({ message: "Choose an active Project to run this task" });
      expect(
        yield* relay({
          ...start,
          sessionId: "loose",
          launchId: "loose",
          runInTarget: "newWorktree",
        }).pipe(Effect.flip),
      ).toMatchObject({ message: "Choose a Project for this worktree." });
      expect(launches).toHaveLength(2);
    }),
);
