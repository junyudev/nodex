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
  if (!isRecord(request)) return request;

  const next = scrubValue(request, undefined, 0, new WeakSet<object>()) as JsonLikeRecord;
  delete next.cookies;
  delete next.data;
  delete next.env;
  delete next.headers;
  delete next.query_string;
  delete next.queryString;
  if (typeof next.url === "string") next.url = scrubUrls(scrubPathFragments(next.url));
  return next;
}

export function scrubSentryData(value: unknown): unknown {
  return scrubValue(value, undefined, 0, new WeakSet<object>());
}

export function scrubSentryEvent<T extends object>(event: T): T {
  const next = scrubValue(event, undefined, 0, new WeakSet<object>()) as T;
  if ("request" in next) {
    (next as JsonLikeRecord).request = scrubRequest(next.request);
  }
  return next;
}

export function scrubSentryBreadcrumb<T extends object>(breadcrumb: T): T {
  return scrubValue(breadcrumb, undefined, 0, new WeakSet<object>()) as T;
}
