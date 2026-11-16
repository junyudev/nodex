type JsonLikeRecord = Record<string, unknown>;

const SENSITIVE_KEY_PATTERN =
  /(?:pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|credential|dsn)/i;
const CONTENT_KEY_PATTERN =
  /(?:prompt|transcript|description|markdown|sql|query|body|content|raw|attachment|clipboard|gen_ai\.(?:input|output|tool\.call\.(?:arguments|result))|mcp\.(?:input|output|tool\.(?:arguments|result)))/i;
const MAX_STRING_LENGTH = 1_000;
const MAX_DEPTH = 6;
const MAX_ARRAY_LENGTH = 20;
const MAX_OBJECT_ENTRIES = 50;

function isRecord(value: unknown): value is JsonLikeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH - 1)}…`;
}

function scrubPathFragments(value: string): string {
  return value
    .replace(/\/Users\/[^/\s]+/g, "/Users/[user]")
    .replace(/\/home\/[^/\s]+/g, "/home/[user]")
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, "C:\\Users\\[user]");
}

function scrubUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>)]*/g, (candidate) => {
    try {
      const url = new URL(candidate);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return candidate.replace(/\?.*$/, "");
    }
  });
}

function scrubSecretFragments(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|pat|ghp|gho|ghu|ghs)_[A-Za-z0-9_]{12,}\b/g, "[REDACTED]");
}

function scrubString(value: string): string {
  return truncateString(scrubSecretFragments(scrubUrls(scrubPathFragments(value))));
}

function scrubValue(
  value: unknown,
  keyHint: string | undefined,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (keyHint && SENSITIVE_KEY_PATTERN.test(keyHint)) {
    return "[REDACTED]";
  }
  if (keyHint && CONTENT_KEY_PATTERN.test(keyHint)) {
    return "[REDACTED]";
  }

  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return String(value);
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;

  if (depth >= MAX_DEPTH) {
    return Array.isArray(value) ? `[Array(${value.length})]` : "[Object]";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((entry) => scrubValue(entry, undefined, depth + 1, seen));
  }

  if (!isRecord(value)) {
    return String(value);
  }

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const next: JsonLikeRecord = {};
  for (const [key, entryValue] of Object.entries(value).slice(0, MAX_OBJECT_ENTRIES)) {
    next[key] = scrubValue(entryValue, key, depth + 1, seen);
  }
  return next;
}

function scrubRequest(request: unknown): unknown {
  const next = scrubSentryData(request);
  if (!isRecord(next)) return next;
  delete next.cookies;
  delete next.data;
  delete next.env;
  delete next.headers;
  delete next.query_string;
  delete next.queryString;
  return next;
}

export function scrubSentryData(value: unknown): unknown {
  return scrubValue(value, undefined, 0, new WeakSet<object>());
}

type FieldScrubbers = Readonly<Record<string, (value: unknown) => unknown>>;

/** Scrubs the named fields with their own scrubbers and the rest as bounded data. */
function scrubShaped(value: unknown, fields: FieldScrubbers): unknown {
  if (!isRecord(value)) return scrubSentryData(value);
  const rest: JsonLikeRecord = {};
  const shaped: JsonLikeRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    const scrub = fields[key];
    if (scrub) shaped[key] = scrub(entry);
    else rest[key] = entry;
  }
  return { ...(scrubSentryData(rest) as JsonLikeRecord), ...shaped };
}

function scrubList(value: unknown, scrubEntry: (entry: unknown) => unknown): unknown {
  return Array.isArray(value) ? value.map(scrubEntry) : scrubSentryData(value);
}

/** A frame keeps its code location; source lines and variables never leave the device. */
function scrubFrame(frame: unknown): unknown {
  if (!isRecord(frame)) return scrubSentryData(frame);
  const {
    vars: _vars,
    pre_context: _pre,
    context_line: _line,
    post_context: _post,
    ...location
  } = frame;
  return scrubSentryData(location);
}

const scrubStacktrace = (stacktrace: unknown) =>
  scrubShaped(stacktrace, { frames: (frames) => scrubList(frames, scrubFrame) });

const scrubStackOwners = (owners: unknown) =>
  scrubShaped(owners, {
    values: (values) =>
      scrubList(values, (owner) => scrubShaped(owner, { stacktrace: scrubStacktrace })),
  });

/**
 * The event's own diagnostic lists are already bounded by the SDK (stack depth, linked errors,
 * maxBreadcrumbs), so they bypass the generic depth and length caps meant for attached data.
 */
const EVENT_FIELDS: FieldScrubbers = {
  exception: scrubStackOwners,
  threads: scrubStackOwners,
  breadcrumbs: (breadcrumbs) => scrubList(breadcrumbs, scrubSentryData),
  debug_meta: (debugMeta) =>
    scrubShaped(debugMeta, { images: (images) => scrubList(images, scrubSentryData) }),
  request: scrubRequest,
};

export function scrubSentryEvent<T extends object>(event: T): T {
  return scrubShaped(event, EVENT_FIELDS) as T;
}

export function scrubSentryBreadcrumb<T extends object>(breadcrumb: T): T {
  return scrubSentryData(breadcrumb) as T;
}
