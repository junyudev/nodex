import { toApiUrl } from "./http-base";
import type { CodexEvent } from "./types";
import type { BoardChangeEvent } from "../../shared/ipc-api";

function isStorybookRuntime(): boolean {
  return typeof window !== "undefined" && window.__NODEX_STORYBOOK__ === true;
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  switch (channel) {
    case "projects:list": {
      const res = await fetch(toApiUrl("/api/projects"));
      const data = await res.json();
      return data.projects;
    }
    case "projects:create": {
      const [input] = args as [{ id: string; name: string; description?: string; icon?: string }];
      const res = await fetch(toApiUrl("/api/projects"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return res.json();
    }
    case "projects:delete": {
      const [projectId] = args as [string];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}`), {
        method: "DELETE",
      });
      const data = await res.json();
      return data.success ?? false;
    }
    case "projects:rename": {
      const [oldId, newId, updates] = args as [
        string,
        string,
        { name?: string; description?: string; icon?: string }?,
      ];
      const res = await fetch(toApiUrl(`/api/projects/${oldId}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newId, ...updates }),
      });
      return res.json();
    }
    case "board:get": {
      const [projectId] = args as [string];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/board`));
      return res.json();
    }
    case "card:create": {
      const [projectId, status, input, sessionId, placement] = args as [
        string,
        string,
        object,
        string | undefined,
        "top" | "bottom" | undefined,
      ];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/board`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, ...input, sessionId, placement }),
      });
      return res.json();
    }
    case "card:update": {
      const [projectId, status, cardId, updates, sessionId, expectedRevision] = args as [
        string,
        string,
        string,
        object,
        string?,
        number?,
      ];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/card`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, cardId, ...updates, sessionId, expectedRevision }),
      });
      if (!res.ok) {
        if (res.status === 404 || res.status === 409) {
          return res.json();
        }
        const error = await res.json().catch(() => ({}));
        const message = typeof error.error === "string" ? error.error : `Request failed: ${res.status}`;
        throw new Error(message);
      }
      return res.json();
    }
    case "card:get": {
      const [projectId, cardId, status] = args as [string, string, string?];
      const params = new URLSearchParams({ cardId });
      if (status) params.set("status", status);
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/card?${params.toString()}`));
      if (!res.ok) return null;
      return res.json();
    }
    case "card:delete": {
      const [projectId, status, cardId, sessionId] = args as [
        string,
        string,
        string,
        string?,
      ];
      const params = new URLSearchParams({ status, cardId });
      if (sessionId) params.set("sessionId", sessionId);
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/card?${params}`), { method: "DELETE" });
      const data = await res.json();
      return data.success ?? false;
    }
    case "card:move": {
      const [input] = args as [{ projectId: string; sessionId?: string }];
      const { projectId, ...rest } = input;
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/move`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rest),
      });
      const data = await res.json();
      return data.success ?? false;
    }
    case "card:move-many": {
      const [input] = args as [{ projectId: string; sessionId?: string }];
      const { projectId, ...rest } = input;
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/move-many`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rest),
      });
      const data = await res.json();
      return data.success ?? false;
    }
    case "card:move-to-project": {
      const [input] = args as [{ sourceProjectId: string; sessionId?: string }];
      const { sourceProjectId, ...rest } = input;
      const res = await fetch(toApiUrl(`/api/projects/${sourceProjectId}/card-move-to-project`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rest),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        const message = typeof error.error === "string" ? error.error : `Request failed: ${res.status}`;
        throw new Error(message);
      }
      return res.json();
    }
    case "workbench:resume:consume": {
      return null;
    }
    case "workbench:resume:save": {
      return false;
    }
    case "card:import-block-drop": {
      const [projectId, input, sessionId] = args as [string, object, string?];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/card-import-block-drop`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, sessionId }),
      });
      return res.json();
    }
    case "calendar:occurrences": {
      const [projectId, windowStart, windowEnd, searchQuery] = args as [string, Date, Date, string?];
      const params = new URLSearchParams({
        start: windowStart.toISOString(),
        end: windowEnd.toISOString(),
      });
      if (searchQuery && searchQuery.trim().length > 0) params.set("search", searchQuery);
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/calendar/occurrences?${params.toString()}`));
      return res.json();
    }
    case "card:occurrence:complete": {
      const [projectId, input, sessionId] = args as [string, { cardId: string; occurrenceStart: Date; source: string }, string?];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/card-occurrence/complete`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...input,
          occurrenceStart: input.occurrenceStart.toISOString(),
          sessionId,
        }),
      });
      return res.json();
    }
    case "card:occurrence:skip": {
      const [projectId, input, sessionId] = args as [string, { cardId: string; occurrenceStart: Date; source: string }, string?];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/card-occurrence/skip`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...input,
          occurrenceStart: input.occurrenceStart.toISOString(),
          sessionId,
        }),
      });
      return res.json();
    }
    case "card:occurrence:update": {
      const [projectId, input, sessionId] = args as [
        string,
        {
          cardId: string;
          occurrenceStart: Date;
          scope: string;
          updates: Record<string, unknown>;
        },
        string?,
      ];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/card-occurrence`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...input,
          occurrenceStart: input.occurrenceStart.toISOString(),
          sessionId,
        }),
      });
      return res.json();
    }
    case "card:move-drop-to-editor": {
      const [projectId, input, sessionId] = args as [string, object, string?];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/card-move-drop-to-editor`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, sessionId }),
      });
      return res.json();
    }
    case "history:recent": {
      const [projectId, sessionId] = args as [string, string?];
      const params = sessionId ? `?sessionId=${sessionId}` : "";
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/history${params}`));
      return res.json();
    }
    case "history:card": {
      const [projectId, cardId] = args as [string, string];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/history/card?cardId=${cardId}`));
      return res.json();
    }
    case "history:undo": {
      const [projectId, sessionId] = args as [string, string?];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/undo`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      return res.json();
    }
    case "history:redo": {
      const [projectId, sessionId] = args as [string, string?];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/redo`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      return res.json();
    }
    case "history:revert": {
      const [projectId, historyId, sessionId] = args as [string, number, string?];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/history/revert`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ historyId, sessionId }),
      });
      return res.json();
    }
    case "history:restore": {
      const [projectId, cardId, historyId, sessionId] = args as [string, string, number, string?];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/history/restore`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId, historyId, sessionId }),
      });
      return res.json();
    }
    case "db:schema": {
      const [projectId] = args as [string];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/schema`));
      return res.json();
    }
    case "db:query": {
      const [projectId, sql, params] = args as [string, string, unknown[]?];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/query`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params }),
      });
      return res.json();
    }
    case "backup:list": {
      const res = await fetch(toApiUrl("/api/backups"));
      const data = await res.json();
      return data.backups;
    }
    case "backup:create": {
      const [input] = args as [{ label?: string }?];
      const res = await fetch(toApiUrl("/api/backups"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input ?? {}),
      });
      return res.json();
    }
    case "backup:restore": {
      const [input] = args as [{ backupId: string; confirm: boolean; createSafetyBackup?: boolean }];
      const res = await fetch(toApiUrl(`/api/backups/${encodeURIComponent(input.backupId)}/restore`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: input.confirm,
          createSafetyBackup: input.createSafetyBackup,
        }),
      });
      return res.json();
    }
    case "settings:backup:get": {
      const res = await fetch(toApiUrl("/api/settings/backup"));
      return res.json();
    }
    case "settings:backup:update": {
      const [input] = args as [{
        autoEnabled: boolean;
        intervalHours: number;
        retentionCount: number;
      }];
      const res = await fetch(toApiUrl("/api/settings/backup"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return res.json();
    }
    case "settings:history:get": {
      const res = await fetch(toApiUrl("/api/settings/history"));
      return res.json();
    }
    case "settings:history:update": {
      const [input] = args as [{ retentionCount: number }];
      const res = await fetch(toApiUrl("/api/settings/history"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return res.json();
    }
    case "settings:thread-notifications:get": {
      const res = await fetch(toApiUrl("/api/settings/thread-notifications"));
      return res.json();
    }
    case "settings:thread-notifications:update": {
      const [input] = args as [{ threadCompletionEnabled: boolean }];
      const res = await fetch(toApiUrl("/api/settings/thread-notifications"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return res.json();
    }
    case "git:branch:state": {
      if (isStorybookRuntime()) {
        return {
          currentBranch: "main",
          defaultBranch: "main",
          branches: ["main", "codex/storybook", "release/candidate"],
        };
      }
      const [cwd] = args as [string];
      const params = new URLSearchParams({ cwd });
      const res = await fetch(toApiUrl(`/api/git/branch?${params.toString()}`));
      return res.json();
    }
    case "git:branch:checkout": {
      if (isStorybookRuntime()) {
        return { success: true };
      }
      const [input] = args as [{ cwd: string; branch: string }];
      const res = await fetch(toApiUrl("/api/git/branch/checkout"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return res.json();
    }
    case "git:branch:create": {
      if (isStorybookRuntime()) {
        return { success: true };
      }
      const [input] = args as [{ cwd: string; branch: string }];
      const res = await fetch(toApiUrl("/api/git/branch/create"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return res.json();
    }
    case "git:branch:watch:start":
    case "git:branch:watch:stop": {
      return;
    }
    case "canvas:get": {
      const [projectId] = args as [string];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/canvas`));
      return res.json();
    }
    case "canvas:save": {
      const [projectId, data] = args as [string, { elements: string; appState: string; files: string; updated: string }];
      const res = await fetch(toApiUrl(`/api/projects/${projectId}/canvas`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      await res.json();
      return;
    }
    case "asset:resolve-path": {
      const [source] = args as [string];
      const res = await fetch(toApiUrl("/api/assets/resolve-path"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      const data = await res.json();
      return data.path ?? null;
    }
    case "clipboard:inspect-paste": {
      return { items: [] };
    }
    case "window:show-emoji-panel": {
      return false;
    }
    case "window:new": {
      return false;
    }
    case "shell:open-file-link": {
      return false;
    }
    case "worktrees:list": {
      return [];
    }
    case "worktrees:environments:list": {
      return [];
    }
    case "codex:permission:custom-description:get": {
      if (isStorybookRuntime()) {
        return "Uses the permission policy defined in your local Codex config.";
      }
      return null;
    }
    case "pty:pick-cwd": {
      return null;
    }
    case "worktrees:delete": {
      return false;
    }
    default:
      throw new Error(`Unknown IPC channel: ${channel}`);
  }
}

function subscribeBoardChanges(projectId: string, callback: () => void): () => void {
  const es = new EventSource(toApiUrl(`/api/projects/${projectId}/events`));

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as BoardChangeEvent & { event?: string };
      if (data.event === "board-changed") {
        callback();
      }
    } catch {
      // ignore parse errors
    }
  };

  return () => es.close();
}

function subscribeCodexEvents(callback: (event: CodexEvent) => void): () => void {
  void callback;
  return () => { };
}

function subscribeGitBranchChanges(callback: (event: { cwd: string }) => void): () => void {
  void callback;
  return () => { };
}

export const browserRendererTransport = {
  kind: "browser" as const,
  invoke,
  subscribeBoardChanges,
  subscribeCodexEvents,
  subscribeGitBranchChanges,
};
