import type {
  ToggleListPropertyKey,
  ToggleListRulesV2,
  ToggleListSettings,
} from "./types";
import {
  TOGGLE_LIST_PROPERTY_KEYS,
} from "./types";
import {
  getDefaultToggleListSettings,
  normalizeToggleListRulesV2,
} from "./settings";

export interface ToggleListInlineViewProps {
  sourceProjectId: string;
  rulesV2B64: string;
  propertyOrderCsv: string;
  hiddenPropertiesCsv: string;
  showEmptyEstimate: "true" | "false";
}

export function getDefaultToggleListInlineViewProps(
  sourceProjectId: string,
): ToggleListInlineViewProps {
  const settings = getDefaultToggleListSettings();
  return {
    sourceProjectId,
    rulesV2B64: encodeRulesV2B64(settings.rulesV2),
    propertyOrderCsv: settings.propertyOrder.join(","),
    hiddenPropertiesCsv: settings.hiddenProperties.join(","),
    showEmptyEstimate: settings.showEmptyEstimate ? "true" : "false",
  };
}

export function parseToggleListInlineViewSettings(
  props: Partial<ToggleListInlineViewProps>,
): ToggleListSettings {
  const defaults = getDefaultToggleListSettings();
  const propertyOrder = normalizePropertyOrder(parseCsvList(props.propertyOrderCsv));
  const hiddenProperties = parseCsvList(props.hiddenPropertiesCsv)
    .filter((item): item is ToggleListPropertyKey =>
      TOGGLE_LIST_PROPERTY_KEYS.includes(item as ToggleListPropertyKey),
    );

  return {
    rulesV2: normalizeToggleListRulesV2(
      decodeRulesV2B64(props.rulesV2B64),
      defaults.rulesV2,
    ),
    propertyOrder,
    hiddenProperties,
    showEmptyEstimate: props.showEmptyEstimate === "true",
  };
}

export function mergeToggleListInlineViewProps(
  prev: Partial<ToggleListInlineViewProps>,
  sourceProjectId: string,
  settings: ToggleListSettings,
): ToggleListInlineViewProps {
  const defaults = getDefaultToggleListInlineViewProps(sourceProjectId);
  const sanitized = sanitizeInlineProps(prev, defaults);
  return {
    ...sanitized,
    sourceProjectId: sourceProjectId || defaults.sourceProjectId,
    rulesV2B64: encodeRulesV2B64(settings.rulesV2),
    propertyOrderCsv: serializeCsvList(settings.propertyOrder),
    hiddenPropertiesCsv: serializeCsvList(settings.hiddenProperties),
    showEmptyEstimate: settings.showEmptyEstimate ? "true" : "false",
  };
}

function sanitizeInlineProps(
  prev: Partial<ToggleListInlineViewProps>,
  defaults: ToggleListInlineViewProps,
): Partial<ToggleListInlineViewProps> {
  return {
    sourceProjectId: typeof prev.sourceProjectId === "string" ? prev.sourceProjectId : defaults.sourceProjectId,
    rulesV2B64: typeof prev.rulesV2B64 === "string" ? prev.rulesV2B64 : defaults.rulesV2B64,
    propertyOrderCsv: typeof prev.propertyOrderCsv === "string" ? prev.propertyOrderCsv : defaults.propertyOrderCsv,
    hiddenPropertiesCsv: typeof prev.hiddenPropertiesCsv === "string"
      ? prev.hiddenPropertiesCsv
      : defaults.hiddenPropertiesCsv,
    showEmptyEstimate: prev.showEmptyEstimate === "true" || prev.showEmptyEstimate === "false"
      ? prev.showEmptyEstimate
      : defaults.showEmptyEstimate,
  };
}

function normalizePropertyOrder(values: string[]): ToggleListPropertyKey[] {
  const deduped = Array.from(
    new Set(
      values.filter((item): item is ToggleListPropertyKey =>
        TOGGLE_LIST_PROPERTY_KEYS.includes(item as ToggleListPropertyKey),
      ),
    ),
  );
  for (const key of TOGGLE_LIST_PROPERTY_KEYS) {
    if (!deduped.includes(key)) deduped.push(key);
  }
  return deduped;
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeCsvList(values: readonly string[]): string {
  return values.join(",");
}

export function encodeRulesV2B64(rulesV2: ToggleListRulesV2): string {
  return encodeBase64Url(JSON.stringify(rulesV2));
}

export function decodeRulesV2B64(value: string | undefined): unknown {
  if (!value) return null;
  const decoded = decodeBase64Url(value);
  if (!decoded) return null;
  try {
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalized.length % 4;
  const padded = remainder === 0 ? normalized : `${normalized}${"=".repeat(4 - remainder)}`;

  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
