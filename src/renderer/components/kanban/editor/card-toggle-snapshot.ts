import type { CardInput, Estimate, Priority } from "../../../lib/types";
import type { ToggleListStatusId } from "../../../lib/toggle-list/types";
import { TOGGLE_LIST_STATUS_LABELS } from "../../../lib/toggle-list/types";
import {
  classifyMetaToken,
  parseMetaTokens,
  tokenToEstimateValue,
  tokenToPriorityValue,
  tokenToStatusId,
} from "../../../lib/toggle-list/meta-chips";

const PRIORITY_TO_TOKEN: Record<Priority, string> = {
  "p0-critical": "P0",
  "p1-high": "P1",
  "p2-medium": "P2",
  "p3-low": "P3",
  "p4-later": "P4",
};

const ESTIMATE_TO_TOKEN: Record<Estimate, string> = {
  xs: "XS",
  s: "S",
  m: "M",
  l: "L",
  xl: "XL",
};

type EditableCardToggleProperty = "priority" | "estimate" | "status";

interface CardToggleSnapshotPayload {
  card?: {
    title?: string;
    description?: string;
    priority?: Priority;
    estimate?: Estimate | null;
    tags?: string[];
    dueDate?: string;
    scheduledStart?: string;
    scheduledEnd?: string;
    isAllDay?: boolean;
    assignee?: string;
    agentBlocked?: boolean;
  };
  projectId?: string;
  status?: string;
  statusName?: string;
  capturedAt?: string;
}

interface CardToggleMetaOverrides {
  priority?: Priority;
  estimate?: Estimate | null;
  hasEstimate: boolean;
  statusId?: ToggleListStatusId;
  tags: string[];
}

function encodeBase64Utf8(value: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "utf8").toString("base64");
  }

  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64Utf8(value: string): string | null {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(value, "base64").toString("utf8");
    }

    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function serializeMetaTokens(tokens: string[]): string {
  return tokens.map((token) => `[${token}]`).join(" ");
}

function toMetaToken(
  propertyType: EditableCardToggleProperty,
  value: string,
): string | null {
  if (propertyType === "priority") {
    return PRIORITY_TO_TOKEN[value as Priority] ?? null;
  }

  if (propertyType === "estimate") {
    if (value === "none") return "-";
    return ESTIMATE_TO_TOKEN[value as Estimate] ?? null;
  }

  if (propertyType === "status") {
    return TOGGLE_LIST_STATUS_LABELS[value as ToggleListStatusId] ?? null;
  }

  return null;
}

export function applyCardToggleMetaEdit(
  meta: string,
  propertyType: EditableCardToggleProperty,
  value: string,
): string {
  const nextToken = toMetaToken(propertyType, value);
  if (!nextToken) return meta;

  const tokens = parseMetaTokens(meta);
  const existingIndex = tokens.findIndex((token) => classifyMetaToken(token) === propertyType);
  if (existingIndex >= 0) {
    tokens[existingIndex] = nextToken;
    return serializeMetaTokens(tokens);
  }

  const insertAt = propertyType === "priority" ? 0 : tokens.length;
  tokens.splice(insertAt, 0, nextToken);
  return serializeMetaTokens(tokens);
}

export function parseCardToggleMetaOverrides(meta: string): CardToggleMetaOverrides {
  const overrides: CardToggleMetaOverrides = {
    hasEstimate: false,
    tags: [],
  };

  for (const token of parseMetaTokens(meta)) {
    const propertyType = classifyMetaToken(token);
    if (propertyType === "priority") {
      const priority = tokenToPriorityValue(token);
      if (priority) {
        overrides.priority = priority;
      }
      continue;
    }

    if (propertyType === "estimate") {
      overrides.hasEstimate = true;
      if (token === "-") {
        overrides.estimate = null;
        continue;
      }
      const estimate = tokenToEstimateValue(token);
      if (estimate) {
        overrides.estimate = estimate;
      }
      continue;
    }

    if (propertyType === "status") {
      const statusId = tokenToStatusId(token);
      if (statusId) {
        overrides.statusId = statusId;
      }
      continue;
    }

    overrides.tags.push(token);
  }

  return overrides;
}

export function parseCardToggleSnapshot(
  snapshot: string,
): CardToggleSnapshotPayload | null {
  const decoded = decodeBase64Utf8(snapshot);
  if (!decoded) return null;

  try {
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as CardToggleSnapshotPayload;
  } catch {
    return null;
  }
}

export function encodeCardToggleSnapshot(
  payload: CardToggleSnapshotPayload,
): string {
  return encodeBase64Utf8(JSON.stringify(payload));
}

export function updateCardToggleSnapshotForMetaEdit(
  snapshot: string,
  propertyType: EditableCardToggleProperty,
  value: string,
): string {
  const parsed = parseCardToggleSnapshot(snapshot);
  if (!parsed) return snapshot;
  if (!parsed.card || typeof parsed.card !== "object") return snapshot;

  if (propertyType === "priority") {
    const priority = value as Priority;
    if (!(priority in PRIORITY_TO_TOKEN)) return snapshot;
    parsed.card.priority = priority;
    return encodeCardToggleSnapshot(parsed);
  }

  if (propertyType === "estimate") {
    if (value === "none") {
      parsed.card.estimate = null;
      return encodeCardToggleSnapshot(parsed);
    }

    const estimate = value as Estimate;
    if (!(estimate in ESTIMATE_TO_TOKEN)) return snapshot;
    parsed.card.estimate = estimate;
    return encodeCardToggleSnapshot(parsed);
  }

  if (propertyType === "status") {
    const statusId = value as ToggleListStatusId;
    if (!(statusId in TOGGLE_LIST_STATUS_LABELS)) return snapshot;
    parsed.status = statusId;
    parsed.statusName = TOGGLE_LIST_STATUS_LABELS[statusId];
    return encodeCardToggleSnapshot(parsed);
  }

  return snapshot;
}

function parseOptionalDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

export function cardInputFromCardToggleSnapshot(
  snapshot: string,
): Partial<CardInput> {
  const parsed = parseCardToggleSnapshot(snapshot);
  if (!parsed?.card || typeof parsed.card !== "object") return {};

  const result: Partial<CardInput> = {};
  const card = parsed.card;

  if (typeof card.priority === "string" && card.priority in PRIORITY_TO_TOKEN) {
    result.priority = card.priority;
  }

  if (
    card.estimate === null
    || (typeof card.estimate === "string" && card.estimate in ESTIMATE_TO_TOKEN)
  ) {
    result.estimate = card.estimate;
  }

  if (Array.isArray(card.tags)) {
    result.tags = card.tags.filter((tag): tag is string => typeof tag === "string");
  }

  const dueDate = parseOptionalDate(card.dueDate);
  if (dueDate) {
    result.dueDate = dueDate;
  }

  const scheduledStart = parseOptionalDate(card.scheduledStart);
  const scheduledEnd = parseOptionalDate(card.scheduledEnd);
  if (scheduledStart && scheduledEnd && scheduledEnd.getTime() <= scheduledStart.getTime()) {
    result.scheduledStart = scheduledStart;
  } else {
    if (scheduledStart) {
      result.scheduledStart = scheduledStart;
    }
    if (scheduledEnd) {
      result.scheduledEnd = scheduledEnd;
    }
  }

  if (typeof card.isAllDay === "boolean") {
    result.isAllDay = card.isAllDay;
  }

  if (typeof card.assignee === "string") {
    result.assignee = card.assignee;
  }

  if (typeof card.agentBlocked === "boolean") {
    result.agentBlocked = card.agentBlocked;
  }

  return result;
}
