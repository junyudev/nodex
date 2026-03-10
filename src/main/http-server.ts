import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import * as dbService from "./kanban/db-service";
import * as backupService from "./kanban/backup-service";
import * as canvasService from "./kanban/canvas-service";
import {
  getBackupSettings,
  getThreadNotificationSettings,
  updateBackupSettings,
  updateThreadNotificationSettings,
} from "./kanban/config";
import { dbNotifier } from "./kanban/db-notifier";
import {
  checkoutGitBranch,
  createAndCheckoutGitBranch,
  readGitBranchState,
} from "./git-branch-service";
import type {
  BlockDropImportInput,
  CardCreatePlacement,
  CardOccurrenceActionInput,
  CardOccurrenceUpdateInput,
  CardDropMoveToEditorInput,
  CardInput,
  MoveCardToProjectInput,
} from "../shared/types";
import { MAX_CARD_WRITE_BODY_BYTES } from "../shared/card-limits";
import {
  MAX_IMAGE_UPLOAD_BYTES,
  readAssetFile,
  resolveAssetPath,
  saveUploadedImage,
  isSupportedImageMimeType,
} from "./kanban/asset-service";
import { parseAssetSource } from "../shared/assets";
import { getLogger } from "./logging/logger";

/** SSE keep-alive ping interval (ms) */
const SSE_PING_INTERVAL_MS = 30_000;

const app = new Hono();
const LOOPBACK_HOST = "127.0.0.1";
const MUTATING_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TRUSTED_BROWSER_ORIGINS = new Set([
  "http://localhost:51284",
  "http://127.0.0.1:51284",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
const cardWriteBodyLimit = bodyLimit({
  maxSize: MAX_CARD_WRITE_BODY_BYTES,
  onError: (c) =>
    c.json(
      { error: `Card payload exceeds ${(MAX_CARD_WRITE_BODY_BYTES / (1024 * 1024)).toFixed(0)}MB limit` },
      413,
    ),
});
const logger = getLogger({ subsystem: "http" });

function isTrustedBrowserOrigin(originHeader: string | undefined): boolean {
  if (!originHeader || originHeader.trim().length === 0) return false;

  try {
    const normalized = new URL(originHeader).origin;
    return TRUSTED_BROWSER_ORIGINS.has(normalized);
  } catch {
    return false;
  }
}

function getRequestLogFields(c: Context, requestId: string, startedAt: number): Record<string, unknown> {
  return {
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
    origin: c.req.header("origin") ?? null,
  };
}

app.use("*", async (c, next) => {
  const requestId = randomUUID();
  const startedAt = Date.now();

  c.header("x-nodex-request-id", requestId);
  await next();

  const level = c.res.status >= 500 ? "error" : c.res.status >= 400 ? "warn" : "info";
  const fields = getRequestLogFields(c, requestId, startedAt);

  if (level === "error") {
    logger.error("HTTP request completed with server error", fields);
    return;
  }
  if (level === "warn") {
    logger.warn("HTTP request completed with client error", fields);
    return;
  }
  logger.info("HTTP request completed", fields);
});

// Reject browser-originated write requests unless they come from a trusted local dev origin.
app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  if (!origin || !MUTATING_HTTP_METHODS.has(c.req.method)) {
    await next();
    return;
  }
  if (isTrustedBrowserOrigin(origin)) {
    await next();
    return;
  }
  return c.json({ error: "Forbidden origin" }, 403);
});

// Only emit CORS headers for trusted local dev browser origins.
app.use("*", cors({
  origin: (origin) => (isTrustedBrowserOrigin(origin) ? origin : null),
}));

app.onError((error, c) => {
  logger.error("HTTP request failed", {
    requestId: c.res.headers.get("x-nodex-request-id") ?? null,
    method: c.req.method,
    path: c.req.path,
    origin: c.req.header("origin") ?? null,
    error,
  });
  return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
});

// === Backup routes ===

app.get("/api/backups", async (c) => {
  const backups = await backupService.listBackups();
  return c.json({ backups });
});

app.post("/api/backups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const backup = await backupService.createBackup({
      trigger: "manual",
      label: typeof body.label === "string" ? body.label : undefined,
    });
    return c.json(backup, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/backups/:backupId/restore", async (c) => {
  const backupId = c.req.param("backupId");
  const body = await c.req.json().catch(() => ({}));
  if (body.confirm !== true) {
    return c.json({ error: "Restore requires confirm=true" }, 400);
  }

  try {
    const result = await backupService.restoreBackup({
      backupId,
      confirm: true,
      createSafetyBackup: body.createSafetyBackup !== false,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof backupService.InvalidBackupIdError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof backupService.BackupNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: (err as Error).message }, 500);
  }
});

// === Settings routes ===

app.get("/api/settings/backup", (c) => {
  return c.json(getBackupSettings());
});

app.put("/api/settings/backup", async (c) => {
  const body = await c.req.json().catch(() => ({}));

  try {
    const settings = updateBackupSettings({
      autoEnabled: body.autoEnabled,
      intervalHours: body.intervalHours,
      retentionCount: body.retentionCount,
    });
    backupService.configureAutoBackupScheduler({
      enabled: settings.autoEnabled,
      intervalHours: settings.intervalHours,
      retentionCount: settings.retentionCount,
    });
    return c.json(settings);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

app.get("/api/settings/thread-notifications", (c) => {
  return c.json(getThreadNotificationSettings());
});

app.put("/api/settings/thread-notifications", async (c) => {
  const body = await c.req.json().catch(() => ({}));

  try {
    const settings = updateThreadNotificationSettings({
      threadCompletionEnabled: body.threadCompletionEnabled,
    });
    return c.json(settings);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

// === Git routes ===

app.get("/api/git/branch", async (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) {
    return c.json({ error: "Missing cwd" }, 400);
  }

  try {
    const state = await readGitBranchState(cwd);
    return c.json(state);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

app.post("/api/git/branch/checkout", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const branch = typeof body.branch === "string" ? body.branch : "";

  try {
    const state = await checkoutGitBranch({ cwd, branch });
    return c.json(state);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

app.post("/api/git/branch/create", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const branch = typeof body.branch === "string" ? body.branch : "";

  try {
    const state = await createAndCheckoutGitBranch({ cwd, branch });
    return c.json(state);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

function parseDueDate(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (value instanceof Date) return value;
  if (typeof value !== "string") throw new Error("Invalid dueDate value");

  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? parseDateOnlyUtc("dueDate", value).toISOString()
    : value;
  assertValidIsoCalendarDate("dueDate", candidate);
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid dueDate "${value}"`);
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertValidIsoCalendarDate(fieldName: string, value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!match) return;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const probe = new Date(Date.UTC(year, month - 1, day));

  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) {
    throw new Error(`Invalid ${fieldName} "${value}"`);
  }
}

function parseDateOnlyUtc(fieldName: string, value: string): Date {
  assertValidIsoCalendarDate(fieldName, value);
  return new Date(`${value}T00:00:00.000Z`);
}

function parseScheduledDate(fieldName: string, value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (value instanceof Date) return value;
  if (typeof value !== "string") throw new Error(`Invalid ${fieldName} value`);

  assertValidIsoCalendarDate(fieldName, value);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${fieldName} "${value}"`);
  }
  return parsed;
}

function parseRequiredDate(fieldName: string, value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string") throw new Error(`Invalid ${fieldName} value`);
  assertValidIsoCalendarDate(fieldName, value);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${fieldName} "${value}"`);
  }
  return parsed;
}

function parseOptionalBoolean(fieldName: string, value: unknown): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  throw new Error(`Invalid ${fieldName} value`);
}

function normalizeCardBody(body: Record<string, unknown>): Record<string, unknown> {
  const result = { ...body };
  if (Object.hasOwn(result, "dueDate")) {
    result.dueDate = parseDueDate(result.dueDate);
  }
  if (Object.hasOwn(result, "scheduledStart")) {
    result.scheduledStart = parseScheduledDate("scheduledStart", result.scheduledStart);
  }
  if (Object.hasOwn(result, "scheduledEnd")) {
    result.scheduledEnd = parseScheduledDate("scheduledEnd", result.scheduledEnd);
  }
  if (Object.hasOwn(result, "isAllDay")) {
    result.isAllDay = parseOptionalBoolean("isAllDay", result.isAllDay);
  }
  return result;
}

function normalizeCardInputValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return normalizeCardBody(value);
}

function normalizeSourceUpdatesValue(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (!isRecord(item)) return item;
    return {
      ...item,
      updates: normalizeCardInputValue(item.updates),
    };
  });
}

export function normalizeBlockDropImportBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...body,
    cards: Array.isArray(body.cards)
      ? body.cards.map((card) => normalizeCardInputValue(card))
      : body.cards,
    sourceUpdates: normalizeSourceUpdatesValue(body.sourceUpdates),
  };
}

export function normalizeCardMoveDropBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...body,
    targetUpdates: normalizeSourceUpdatesValue(body.targetUpdates),
  };
}

// === Project routes ===

app.get("/api/projects", (c) => {
  const projects = dbService.listProjects();
  return c.json({ projects });
});

app.post("/api/projects", async (c) => {
  const body = await c.req.json();
  try {
    const project = dbService.createProject(body);
    return c.json(project, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.get("/api/projects/:projectId", (c) => {
  const project = dbService.getProject(c.req.param("projectId"));
  if (!project) return c.json({ error: "Not found" }, 404);
  return c.json(project);
});

app.put("/api/projects/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await c.req.json();
  try {
    const result = dbService.renameProject(
      projectId,
      body.newId || projectId,
      {
        name: body.name,
        description: body.description,
        icon: body.icon,
        workspacePath: body.workspacePath,
      }
    );
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.delete("/api/projects/:projectId", (c) => {
  const success = dbService.deleteProject(c.req.param("projectId"));
  if (!success) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

// === Board routes ===

app.get("/api/projects/:projectId/board", async (c) => {
  const board = await dbService.getBoard(c.req.param("projectId"));
  return c.json(board);
});

app.post("/api/projects/:projectId/board", cardWriteBodyLimit, async (c) => {
  const projectId = c.req.param("projectId");
  const body = (await c.req.json()) as Record<string, unknown>;
  try {
    const { columnId, sessionId, placement, ...input } = normalizeCardBody(body);
    if (typeof columnId !== "string" || columnId.length === 0) {
      return c.json({ error: "Missing columnId" }, 400);
    }
    if (placement !== undefined && placement !== "top" && placement !== "bottom") {
      return c.json({ error: "Invalid placement" }, 400);
    }
    const normalizedSessionId = typeof sessionId === "string" ? sessionId : undefined;
    const normalizedPlacement: CardCreatePlacement = placement === "top" ? "top" : "bottom";
    const card = await dbService.createCard(
      projectId,
      columnId,
      input as unknown as CardInput,
      normalizedSessionId,
      normalizedPlacement,
    );
    return c.json(card, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// === Asset routes ===

app.post("/api/assets/resolve-path", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const source = typeof body.source === "string" ? body.source : "";
  const parsed = parseAssetSource(source);
  if (!parsed) {
    return c.json({ path: null });
  }

  try {
    const path = resolveAssetPath(parsed.fileName);
    return c.json({ path });
  } catch {
    return c.json({ path: null });
  }
});

async function handleImageUpload(c: Context) {
  const body = await c.req.parseBody();
  const upload = body.file;
  if (!(upload instanceof File)) {
    return c.json({ error: "Missing image file" }, 400);
  }

  if (!isSupportedImageMimeType(upload.type)) {
    return c.json({ error: `Unsupported image type: ${upload.type || "unknown"}` }, 400);
  }

  try {
    const result = await saveUploadedImage(upload);
    return c.json({ source: result.source }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
}

app.post(
  "/api/assets/images",
  bodyLimit({
    maxSize: MAX_IMAGE_UPLOAD_BYTES,
    onError: (c) => c.json({ error: "Image exceeds 10MB upload limit" }, 413),
  }),
  async (c) => handleImageUpload(c),
);

app.get("/api/assets/:fileName", (c) => {
  const fileName = c.req.param("fileName");

  try {
    const { bytes, mimeType } = readAssetFile(fileName);
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": mimeType,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

// === Card routes ===

app.get("/api/projects/:projectId/card", async (c) => {
  const projectId = c.req.param("projectId");
  const columnId = c.req.query("columnId") || undefined;
  const cardId = c.req.query("cardId");
  if (!cardId) return c.json({ error: "Missing cardId" }, 400);
  const result = await dbService.getCard(projectId, cardId, columnId);
  if (!result) return c.json({ error: "Not found" }, 404);
  return c.json({ ...result.card, columnId: result.columnId });
});

app.put("/api/projects/:projectId/card", cardWriteBodyLimit, async (c) => {
  const projectId = c.req.param("projectId");
  const body = (await c.req.json()) as Record<string, unknown>;
  try {
    const {
      columnId,
      cardId,
      sessionId,
      expectedRevision,
      ...updates
    } = normalizeCardBody(body);
    if (typeof cardId !== "string") {
      return c.json({ error: "Missing cardId" }, 400);
    }
    const normalizedColumnId = typeof columnId === "string" ? columnId : undefined;
    const normalizedSessionId = typeof sessionId === "string" ? sessionId : undefined;
    const normalizedExpectedRevision = typeof expectedRevision === "number"
      && Number.isInteger(expectedRevision)
      ? expectedRevision
      : undefined;
    const result = await dbService.updateCard(
      projectId,
      normalizedColumnId,
      cardId,
      updates as Partial<CardInput>,
      normalizedSessionId,
      normalizedExpectedRevision,
    );
    if (result.status === "not_found") {
      return c.json(result, 404);
    }
    if (result.status === "conflict") {
      return c.json(result, 409);
    }
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.delete("/api/projects/:projectId/card", async (c) => {
  const projectId = c.req.param("projectId");
  const columnId = c.req.query("columnId") || undefined;
  const cardId = c.req.query("cardId");
  const sessionId = c.req.query("sessionId") || undefined;
  if (!cardId) return c.json({ error: "Missing cardId" }, 400);
  const success = await dbService.deleteCard(projectId, columnId, cardId, sessionId);
  if (!success) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.get("/api/projects/:projectId/calendar/occurrences", async (c) => {
  const projectId = c.req.param("projectId");
  const startRaw = c.req.query("start");
  const endRaw = c.req.query("end");
  const searchQuery = c.req.query("search") || undefined;

  try {
    const start = parseRequiredDate("start", startRaw);
    const end = parseRequiredDate("end", endRaw);
    const occurrences = await dbService.listCalendarOccurrences(projectId, start, end, searchQuery);
    return c.json({ occurrences });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.post("/api/projects/:projectId/card-occurrence/complete", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await c.req.json().catch(() => ({}));
  try {
    if (!isRecord(body)) throw new Error("Invalid request body");
    if (typeof body.cardId !== "string") throw new Error("Missing cardId");
    if (typeof body.source !== "string") throw new Error("Missing source");
    const input: CardOccurrenceActionInput = {
      cardId: body.cardId,
      occurrenceStart: parseRequiredDate("occurrenceStart", body.occurrenceStart),
      source: body.source as CardOccurrenceActionInput["source"],
    };
    const result = await dbService.completeCardOccurrence(
      projectId,
      input,
      typeof body.sessionId === "string" ? body.sessionId : undefined,
    );
    if (!result.success) return c.json(result, 400);
    return c.json(result);
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 400);
  }
});

app.post("/api/projects/:projectId/card-occurrence/skip", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await c.req.json().catch(() => ({}));
  try {
    if (!isRecord(body)) throw new Error("Invalid request body");
    if (typeof body.cardId !== "string") throw new Error("Missing cardId");
    if (typeof body.source !== "string") throw new Error("Missing source");
    const input: CardOccurrenceActionInput = {
      cardId: body.cardId,
      occurrenceStart: parseRequiredDate("occurrenceStart", body.occurrenceStart),
      source: body.source as CardOccurrenceActionInput["source"],
    };
    const result = await dbService.skipCardOccurrence(
      projectId,
      input,
      typeof body.sessionId === "string" ? body.sessionId : undefined,
    );
    if (!result.success) return c.json(result, 400);
    return c.json(result);
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 400);
  }
});

app.put("/api/projects/:projectId/card-occurrence", cardWriteBodyLimit, async (c) => {
  const projectId = c.req.param("projectId");
  const body = await c.req.json().catch(() => ({}));
  try {
    if (!isRecord(body)) throw new Error("Invalid request body");
    if (typeof body.cardId !== "string") throw new Error("Missing cardId");
    if (typeof body.scope !== "string") throw new Error("Missing scope");
    if (!isRecord(body.updates)) throw new Error("Missing updates");
    const updates = normalizeCardBody(body.updates);
    const input: CardOccurrenceUpdateInput = {
      cardId: body.cardId,
      occurrenceStart: parseRequiredDate("occurrenceStart", body.occurrenceStart),
      source: "api",
      scope: body.scope as CardOccurrenceUpdateInput["scope"],
      updates: updates as CardOccurrenceUpdateInput["updates"],
    };
    const result = await dbService.updateCardOccurrence(
      projectId,
      input,
      typeof body.sessionId === "string" ? body.sessionId : undefined,
    );
    if (!result.success) return c.json(result, 400);
    return c.json(result);
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 400);
  }
});

// === Column route ===

app.get("/api/projects/:projectId/column", async (c) => {
  const projectId = c.req.param("projectId");
  const columnId = c.req.query("id");
  if (!columnId) return c.json({ error: "Missing id" }, 400);
  const column = await dbService.readColumn(projectId, columnId);
  return c.json(column);
});

// === Move route ===

app.put("/api/projects/:projectId/move", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await c.req.json();
  const result = await dbService.moveCard({ ...body, projectId });
  if (result === "wrong_column") {
    return c.json({ error: "Card is no longer in the expected column" }, 409);
  }
  if (result === "not_found") return c.json({ error: "Card not found" }, 404);
  return c.json({ success: true });
});

app.put("/api/projects/:projectId/move-many", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await c.req.json();
  const result = await dbService.moveCards({ ...body, projectId });
  if (result === "wrong_column") {
    return c.json({ error: "One or more cards are no longer in the expected column" }, 409);
  }
  if (result === "not_found") return c.json({ error: "One or more cards were not found" }, 404);
  return c.json({ success: true });
});

app.post("/api/projects/:projectId/card-move-to-project", async (c) => {
  const sourceProjectId = c.req.param("projectId");
  const body = await c.req.json().catch(() => ({}));

  try {
    if (!isRecord(body)) throw new Error("Invalid request body");
    if (typeof body.cardId !== "string" || body.cardId.length === 0) {
      throw new Error("Missing cardId");
    }
    if (typeof body.targetProjectId !== "string" || body.targetProjectId.length === 0) {
      throw new Error("Missing targetProjectId");
    }

    const input: MoveCardToProjectInput = {
      cardId: body.cardId,
      sourceProjectId,
      sourceColumnId: typeof body.sourceColumnId === "string" ? body.sourceColumnId : undefined,
      targetProjectId: body.targetProjectId,
      targetColumnId: typeof body.targetColumnId === "string" ? body.targetColumnId : undefined,
    };

    const result = await dbService.moveCardToProject(input);
    if (result === "wrong_column") {
      return c.json({ error: "Card is no longer in the expected column" }, 409);
    }
    if (result === "not_found") {
      return c.json({ error: "Card not found" }, 404);
    }
    if (result === "target_project_not_found") {
      return c.json({ error: "Target project not found" }, 404);
    }
    return c.json(result, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.post("/api/projects/:projectId/card-import-block-drop", cardWriteBodyLimit, async (c) => {
  const projectId = c.req.param("projectId");
  const body = (await c.req.json()) as Record<string, unknown>;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;

  const input = normalizeBlockDropImportBody({ ...body });
  delete input.sessionId;
  try {
    const result = await dbService.importBlockDropAsCards(
      projectId,
      input as unknown as BlockDropImportInput,
      sessionId,
    );
    return c.json(result, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.post("/api/projects/:projectId/card-move-drop-to-editor", cardWriteBodyLimit, async (c) => {
  const projectId = c.req.param("projectId");
  const body = (await c.req.json()) as Record<string, unknown>;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;

  const input = normalizeCardMoveDropBody({ ...body });
  delete input.sessionId;
  try {
    const result = await dbService.moveCardDropToEditor(
      projectId,
      input as unknown as CardDropMoveToEditorInput,
      sessionId,
    );
    return c.json(result, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// === Canvas routes ===

app.get("/api/projects/:projectId/canvas", (c) => {
  const projectId = c.req.param("projectId");
  const data = canvasService.getCanvas(projectId);
  if (!data) return c.json(null);
  return c.json(data);
});

/** 20 MB limit for canvas payload (includes embedded image files) */
const CANVAS_BODY_LIMIT = 20 * 1024 * 1024;

app.put(
  "/api/projects/:projectId/canvas",
  bodyLimit({
    maxSize: CANVAS_BODY_LIMIT,
    onError: (c) => c.json({ error: "Canvas payload exceeds 20MB limit" }, 413),
  }),
  async (c) => {
    const projectId = c.req.param("projectId");
    if (!dbService.getProject(projectId)) {
      return c.json({ error: "Project not found" }, 404);
    }
    const body = await c.req.json();
    if (typeof body.elements !== "string" || typeof body.appState !== "string") {
      return c.json({ error: "elements and appState must be JSON strings" }, 400);
    }
    if (body.files !== undefined && typeof body.files !== "string") {
      return c.json({ error: "files must be a JSON string when provided" }, 400);
    }
    try {
      canvasService.saveCanvas(projectId, {
        elements: body.elements,
        appState: body.appState,
        files: typeof body.files === "string" ? body.files : "{}",
        updated: typeof body.updated === "string" ? body.updated : new Date().toISOString(),
      });
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  },
);

// === SSE events ===

app.get("/api/projects/:projectId/events", (c) => {
  const projectId = c.req.param("projectId");

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (data: string) => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      // Send initial connection event
      send(JSON.stringify({ event: "connected" }));

      const handler = (event: { projectId: string }) => {
        if (event.projectId === projectId) {
          send(JSON.stringify({ event: "board-changed" }));
        }
      };

      dbNotifier.on("board-changed", handler);

      // Keep-alive ping
      const pingInterval = setInterval(() => {
        try {
          send(JSON.stringify({ event: "ping" }));
        } catch {
          clearInterval(pingInterval);
        }
      }, SSE_PING_INTERVAL_MS);

      // Cleanup when stream is cancelled
      c.req.raw.signal.addEventListener("abort", () => {
        dbNotifier.removeListener("board-changed", handler);
        clearInterval(pingInterval);
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// === History routes ===

app.get("/api/projects/:projectId/history", (c) => {
  const projectId = c.req.param("projectId");
  const sessionId = c.req.query("sessionId") || undefined;
  const limitRaw = c.req.query("limit");
  const offsetRaw = c.req.query("offset");

  const parsedLimit = Number.parseInt(limitRaw ?? "20", 10);
  const parsedOffset = Number.parseInt(offsetRaw ?? "0", 10);

  const limit = Number.isInteger(parsedLimit) && parsedLimit >= 0 ? parsedLimit : 20;
  const offset = Number.isInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

  const entries = dbService.getRecentHistory(projectId, limit, offset);
  const state = dbService.getUndoRedoState(projectId, sessionId);
  return c.json({ ...state, entries });
});

app.get("/api/projects/:projectId/history/card", (c) => {
  const projectId = c.req.param("projectId");
  const cardId = c.req.query("cardId");
  if (!cardId) return c.json({ error: "Missing cardId" }, 400);
  const entries = dbService.getCardHistory(projectId, cardId);
  return c.json({ entries });
});

// === Revert/Restore routes ===

app.post("/api/projects/:projectId/history/revert", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await c.req.json();
  const historyId = body.historyId;
  if (typeof historyId !== "number") return c.json({ error: "Missing or invalid historyId" }, 400);
  const sessionId = body.sessionId;
  return c.json(dbService.revertEntry(projectId, historyId, sessionId));
});

app.post("/api/projects/:projectId/history/restore", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await c.req.json();
  const { cardId, historyId, sessionId } = body;
  if (!cardId || typeof historyId !== "number") {
    return c.json({ error: "Missing cardId or invalid historyId" }, 400);
  }
  return c.json(dbService.restoreToEntry(projectId, cardId, historyId, sessionId));
});

// === Undo/Redo routes ===

app.post("/api/projects/:projectId/undo", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await c.req.json();
  const sessionId = body.sessionId;
  return c.json(dbService.undoLatest(projectId, sessionId));
});

app.post("/api/projects/:projectId/redo", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await c.req.json();
  const sessionId = body.sessionId;
  return c.json(dbService.redoLatest(projectId, sessionId));
});

// === Schema/Query routes ===

app.get("/api/projects/:projectId/schema", () => {
  const schema = dbService.getSchema();
  return Response.json(schema);
});

app.post("/api/projects/:projectId/query", async (c) => {
  const body = await c.req.json();
  try {
    const result = dbService.executeReadOnlyQuery(body.sql, body.params);
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

export function getHttpServerOptions(port: number): {
  fetch: typeof app.fetch;
  port: number;
  hostname: string;
} {
  return {
    fetch: app.fetch,
    port,
    hostname: LOOPBACK_HOST,
  };
}

export function startHttpServer(port: number): void {
  serve(getHttpServerOptions(port), (info) => {
    logger.info("HTTP server started", {
      host: LOOPBACK_HOST,
      port: info.port,
    });
  });
}
