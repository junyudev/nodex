import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Thread } from "@nodex/codex-app-server-protocol/v2/Thread";
import type { ScenarioManifest } from "../contracts";

/** Give the Core-seeded working chat the same live native facts during Electron inspection. */
export async function seedCoordinatorNativeExecution(root: string, manifest: ScenarioManifest) {
  const id = manifest.entityIdsByKey?.chainStartThread;
  if (!id) throw new Error("Coordinator working thread is missing");
  const now = Math.floor(Date.now() / 1000);
  const thread: Thread = {
    id,
    sessionId: id,
    cwd: root,
    name: "Build keyboard navigation",
    preview: "Working through the keyboard interaction.",
    ephemeral: false,
    modelProvider: "openai",
    environments: null,
    model: "gpt-5.5",
    reasoningEffort: "medium",
    extra: null,
    forkedFromId: null,
    parentThreadId: null,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    recencyAt: now,
    originator: null,
    canAcceptDirectInput: true,
    threadSource: "user",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    daybreakEnabled: null,
    createdAt: now,
    updatedAt: now,
    source: { custom: "nodex-e2e" },
    status: { type: "active", activeFlags: [] },
    path: null,
    cliVersion: "0.145.0-alpha.15",
    turns: [
      {
        id: "scenario:chainStart",
        rootTurnId: null,
        status: "inProgress",
        items: [],
        itemsView: "full",
        error: null,
        startedAt: now,
        completedAt: null,
        durationMs: null,
      },
    ],
  };
  const file = path.join(root, "codex-state.json");
  const state: { threads: Record<string, Thread> } = await readFile(file, "utf8")
    .then((text: string) => JSON.parse(text) as { threads: Record<string, Thread> })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { threads: {} };
      throw error;
    });
  await writeFile(file, JSON.stringify({ ...state, threads: { ...state.threads, [id]: thread } }));
}
