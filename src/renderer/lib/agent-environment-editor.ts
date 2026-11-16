import { getIntl, type IntlShape } from "@/lib/i18n";
import type {
  AgentEnvironmentInput,
  FormatEnvironmentValidation,
} from "../../shared/agent-environment";

export interface AgentEnvironmentDraft {
  readonly id: string;
  readonly name: string;
  readonly value: string | null;
  readonly sensitive: boolean;
}

export interface AgentEnvironmentPolicy {
  readonly limit: number;
  readonly nameError: (name: string, formatMessage?: FormatEnvironmentValidation) => string | null;
  readonly inputSchema: {
    readonly parse: (input: unknown) => AgentEnvironmentInput;
    readonly safeParse: (input: unknown) => { readonly success: boolean };
  };
}

export const environmentIsSensitive = (name: string): boolean =>
  !/(?:_URL|_MODEL|_TIMEOUT(?:_MS)?|_MAX_TOKENS|_MAX_OUTPUT_TOKENS)$/u.test(name);

export const environmentAssignmentPaste = (text: string, allowBareAssignment = true): boolean =>
  text.trim().includes("\n") ||
  /^\s*export[ \t]+/u.test(text) ||
  (allowBareAssignment && /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/u.test(text));

/** Parse literal .env/export assignments without shell evaluation or expansion. */
export function parseEnvironmentAssignments(
  text: string,
  policy: AgentEnvironmentPolicy,
  intl: IntlShape = getIntl(),
): { variables: AgentEnvironmentInput[]; error?: never } | { error: string; variables?: never } {
  const variables: AgentEnvironmentInput[] = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/u.exec(line);
    if (!match)
      return {
        error: intl.formatMessage(
          {
            id: "lib.agentEnvironmentEditor.assignmentSyntax",
            defaultMessage: 'Line {line}: use KEY=value or export KEY="value".',
          },
          { line: index + 1 },
        ),
      };
    const name = match[1]!;
    const nameError = policy.nameError(name, intl.formatMessage);
    if (nameError)
      return {
        error: intl.formatMessage(
          {
            id: "lib.agentEnvironmentEditor.assignmentName",
            defaultMessage: "Line {line}: {reason}",
          },
          { line: index + 1, reason: nameError },
        ),
      };
    const value = parseLiteral(match[2]!);
    if (value === null)
      return {
        error: intl.formatMessage(
          {
            id: "lib.agentEnvironmentEditor.assignmentLiteral",
            defaultMessage: "Line {line}: use a literal value without shell expressions.",
          },
          { line: index + 1 },
        ),
      };
    const variable = { name, value, sensitive: environmentIsSensitive(name) };
    if (!policy.inputSchema.safeParse(variable).success)
      return {
        error: intl.formatMessage(
          {
            id: "lib.agentEnvironmentEditor.assignmentValue",
            defaultMessage: "Line {line}: the value is too long or contains a null character.",
          },
          { line: index + 1 },
        ),
      };
    if (variables.some((entry) => entry.name === name))
      return {
        error: intl.formatMessage(
          {
            id: "lib.agentEnvironmentEditor.duplicateAssignment",
            defaultMessage: "Line {line}: duplicate variable name.",
          },
          { line: index + 1 },
        ),
      };
    variables.push(variable);
  }
  if (!variables.length)
    return {
      error: intl.formatMessage({
        id: "lib.agentEnvironmentEditor.emptyPaste",
        defaultMessage: "Paste at least one environment variable.",
      }),
    };
  if (variables.length > policy.limit)
    return {
      error: intl.formatMessage(
        {
          id: "lib.agentEnvironmentEditor.variableLimit",
          defaultMessage: "Use at most {count} variables.",
        },
        { count: policy.limit },
      ),
    };
  return { variables };
}

function parseLiteral(source: string): string | null {
  const quote = source[0];
  if (quote !== '"' && quote !== "'") {
    const value = source.replace(/\s+#.*$/u, "").trimEnd();
    return /[\s$`\\;&|<>]/u.test(value) ? null : value;
  }
  let value = "";
  for (let index = 1; index < source.length; index++) {
    const char = source[index]!;
    if (char === quote) return /^(?:\s*(?:#.*)?)$/u.test(source.slice(index + 1)) ? value : null;
    if (quote === "'") {
      value += char;
      continue;
    }
    if (char === "$" || char === "`") return null;
    if (char !== "\\") {
      value += char;
      continue;
    }
    const escaped = source[++index];
    if (!escaped || !'"\\$`'.includes(escaped)) return null;
    value += escaped;
  }
  return null;
}

export function validateEnvironmentDraft(
  rows: readonly AgentEnvironmentDraft[],
  policy: AgentEnvironmentPolicy,
  intl: IntlShape = getIntl(),
): string | null {
  if (rows.length > policy.limit)
    return intl.formatMessage(
      {
        id: "lib.agentEnvironmentEditor.variableLimit",
        defaultMessage: "Use at most {count} variables.",
      },
      { count: policy.limit },
    );
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name && row.value === "") continue;
    const error = policy.nameError(name, intl.formatMessage);
    if (error) return error;
    if (names.has(name))
      return intl.formatMessage({
        id: "lib.agentEnvironmentEditor.duplicateNames",
        defaultMessage: "Each environment variable name must be unique.",
      });
    names.add(name);
    if (!policy.inputSchema.safeParse({ name, value: row.value, sensitive: row.sensitive }).success)
      return intl.formatMessage({
        id: "lib.agentEnvironmentEditor.invalidValue",
        defaultMessage: "Enter a valid value for each variable.",
      });
  }
  return null;
}

export function environmentDraftInput(
  rows: readonly AgentEnvironmentDraft[],
  policy: AgentEnvironmentPolicy,
): AgentEnvironmentInput[] {
  return rows
    .filter((row) => row.name.trim() || row.value !== "")
    .map((row) =>
      policy.inputSchema.parse({
        name: row.name.trim(),
        value: row.value,
        sensitive: row.sensitive,
      }),
    );
}

export function mergeEnvironmentPaste(
  rows: readonly AgentEnvironmentDraft[],
  variables: readonly AgentEnvironmentInput[],
): AgentEnvironmentDraft[] {
  const remaining = rows.filter((row) => row.name.trim() || row.value !== "");
  const incoming = new Map(variables.map((variable) => [variable.name, variable]));
  const next = remaining.map((row) => {
    const replacement = incoming.get(row.name.trim());
    if (!replacement) return row;
    incoming.delete(replacement.name);
    return { ...replacement, id: row.id };
  });
  return [
    ...next,
    ...Array.from(incoming.values(), (variable) => ({ ...variable, id: crypto.randomUUID() })),
  ];
}
