import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";
import type { MarkdownSourceSpan } from "../nodex-markdown";

const keys = ["name", "description"] as const;
type FieldName = (typeof keys)[number];

export type SkillFrontmatterPatch = Readonly<Partial<Record<FieldName, string>>>;
export type SkillFrontmatter = Readonly<
  Record<
    FieldName,
    {
      readonly value: string | null;
      readonly patchable: boolean;
    }
  >
>;

interface Field {
  readonly value: string | null;
  readonly span?: MarkdownSourceSpan;
}

export interface SkillHeader {
  readonly bodyStart: number;
  readonly fields: Readonly<Record<FieldName, Field>>;
  readonly reason?: string;
  readonly patchReason?: string;
}

export function readSkillHeader(text: string): SkillHeader {
  const start = text.startsWith("\uFEFF") ? 1 : 0;
  const fields: Record<FieldName, Field> = { name: { value: null }, description: { value: null } };
  const opener = /^---[ \t]*(?:\r\n|\r|\n|$)/.exec(text.slice(start));
  if (!opener) return { bodyStart: start, fields };

  const yamlStart = start + opener[0].length;
  const rest = text.slice(yamlStart);
  const closer = /(^|\r\n|\r|\n)(?:---|\.\.\.)[ \t]*(?:\r\n|\r|\n|$)/.exec(rest);
  if (!closer)
    return { bodyStart: text.length, fields, reason: "The frontmatter has no closing delimiter." };

  const bodyStart = yamlStart + closer.index + closer[0].length;
  const yaml = rest.slice(0, closer.index + closer[1]!.length);
  const document = parseDocument(yaml);
  const map = document.contents;
  if (document.errors.length || document.warnings.length || !isMap(map)) {
    return {
      bodyStart,
      fields,
      reason: "The frontmatter must be a valid YAML mapping with unique keys.",
    };
  }

  let hasAlias = false;
  visit(map, {
    Alias: () => {
      hasAlias = true;
    },
  });
  const patchReason = hasAlias
    ? "Frontmatter with YAML aliases must be edited in Source."
    : map.flow
      ? "Flow-style frontmatter must be edited in Source."
      : undefined;
  for (const key of keys) {
    const value = map.get(key, true);
    const node = isAlias(value) ? value.resolve(document) : value;
    if (!isScalar(node) || typeof node.value !== "string") continue;
    const field: Field = { value: node.value };
    const [start, end] = node.range ?? [0, 0];
    const patchable =
      !patchReason &&
      !node.anchor &&
      !node.tag &&
      start < end &&
      !/[\r\n]/.test(yaml.slice(start, end));
    fields[key] = patchable
      ? { ...field, span: { start: yamlStart + start, end: yamlStart + end } }
      : field;
  }

  return { bodyStart, fields, patchReason };
}

export function patchSkillHeader(
  text: string,
  patch: SkillFrontmatterPatch,
): { ok: true; text: string } | { ok: false; reason: string } {
  const header = readSkillHeader(text);
  if (header.reason) return { ok: false, reason: header.reason };
  if (header.patchReason && keys.some((key) => patch[key] !== undefined)) {
    return { ok: false, reason: header.patchReason };
  }
  const edits: { span: MarkdownSourceSpan; value: string }[] = [];
  for (const key of keys) {
    const value = patch[key];
    if (value === undefined) continue;
    const field = header.fields[key];
    if (!field.span)
      return {
        ok: false,
        reason:
          'The frontmatter field "' + key + '" needs a single-line YAML string to edit it here.',
      };
    if (field.value !== value) edits.push({ span: field.span, value });
  }

  let candidate = text;
  for (const { span, value } of edits.sort((a, b) => b.span.start - a.span.start)) {
    candidate = candidate.slice(0, span.start) + JSON.stringify(value) + candidate.slice(span.end);
  }
  const checked = readSkillHeader(candidate);
  if (
    checked.reason ||
    keys.some((key) => checked.fields[key].value !== (patch[key] ?? header.fields[key].value)) ||
    candidate.slice(checked.bodyStart) !== text.slice(header.bodyStart)
  ) {
    return { ok: false, reason: "The replacement does not preserve the frontmatter structure." };
  }
  return { ok: true, text: candidate };
}
