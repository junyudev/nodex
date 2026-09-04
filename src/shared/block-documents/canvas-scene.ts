import { fileSource, parseFileSource } from "../file-resources";
import {
  stableStringifyBlockPropertyJson,
  type BlockPropertyJsonValue,
} from "../block-property-mutations";

export const CANVAS_SCENE_KIND = "canvas_scene" as const;
export const CANVAS_SCENE_SCHEMA_VERSION = 2 as const;

export const MAX_CANVAS_SCENE_ELEMENTS = 100_000;
export const MAX_CANVAS_SCENE_FILES = 10_000;
export const MAX_CANVAS_SCENE_ID_LENGTH = 512;
export const MAX_CANVAS_SCENE_ORDER_KEY_LENGTH = 256;
export const MAX_CANVAS_SCENE_SHARED_TEXT_LENGTH = 4_000_000;

const MAX_PROJECTION_JSON_LENGTH = 128 * 1024 * 1024;
const MAX_PROJECTION_JSON_NODES = 2_000_000;
const MAX_PROJECTION_JSON_DEPTH = 64;
const MAX_ELEMENT_JSON_NODES = 100_000;
const MAX_ELEMENT_JSON_DEPTH = 32;

export const DURABLE_CANVAS_SCENE_APP_STATE_KEYS = [
  "gridModeEnabled",
  "gridSize",
  "gridStep",
  "viewBackgroundColor",
] as const;

const durableAppStateKeys = new Set<string>(DURABLE_CANVAS_SCENE_APP_STATE_KEYS);

export type CanvasSceneJsonValue = BlockPropertyJsonValue;
export type CanvasSceneElement = Readonly<Record<string, CanvasSceneJsonValue>>;

export interface CanvasSceneFile {
  readonly id: string;
  readonly mimeType: string;
  readonly source: string;
  readonly fileVersion: number;
  readonly defaultName: string;
  readonly created?: number;
}

export type CanvasSceneAppState = Readonly<Record<string, CanvasSceneJsonValue>>;

export interface CanvasScenePageReference {
  readonly sourceElementId: string;
  readonly targetBlockId: string;
  readonly titleHint?: string;
}

export interface PortableCanvasScene {
  readonly kind: typeof CANVAS_SCENE_KIND;
  readonly schemaVersion: typeof CANVAS_SCENE_SCHEMA_VERSION;
  readonly elements: readonly CanvasSceneElement[];
  readonly appState: CanvasSceneAppState;
  readonly files: Readonly<Record<string, CanvasSceneFile>>;
  readonly pageReferences: readonly CanvasScenePageReference[];
  readonly plainText: string;
  readonly preview: string;
}

export interface CanvasSceneForwardRestorePlan {
  readonly kind: "canvas_scene_forward_restore";
  readonly restoreIdentity: string;
  readonly targetSemanticFingerprint: string;
  readonly elementCandidates: readonly CanvasSceneElement[];
  readonly appState: CanvasSceneAppState;
  readonly files: Readonly<Record<string, CanvasSceneFile>>;
  readonly restoredElementIds: readonly string[];
}

export class CanvasSceneContractError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CanvasSceneContractError";
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requireCanvasSceneIdentity = (value: unknown, field: string): string => {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CANVAS_SCENE_ID_LENGTH &&
    value === value.trim()
  ) {
    return value;
  }
  throw new CanvasSceneContractError(`${field} must be a canonical bounded identity`);
};

const requireSafeInteger = (value: unknown, field: string, minimum: number): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum) {
    return value;
  }
  throw new CanvasSceneContractError(`${field} must be a safe integer >= ${minimum}`);
};

const canonicalJsonRecord = (
  value: unknown,
  field: string,
): Readonly<Record<string, CanvasSceneJsonValue>> => {
  if (!isRecord(value)) {
    throw new CanvasSceneContractError(`${field} must be a JSON object`);
  }
  try {
    const parsed = JSON.parse(stableStringifyBlockPropertyJson(value)) as unknown;
    if (isRecord(parsed)) {
      return parsed as Readonly<Record<string, CanvasSceneJsonValue>>;
    }
  } catch (error) {
    throw new CanvasSceneContractError(`${field} must contain bounded portable JSON`, {
      cause: error,
    });
  }
  throw new CanvasSceneContractError(`${field} must be a JSON object`);
};

export const canonicalStringifyCanvasScene = (value: unknown): string => {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_PROJECTION_JSON_NODES) {
      throw new CanvasSceneContractError("Canvas scene exceeds the JSON node limit");
    }
    if (depth > MAX_PROJECTION_JSON_DEPTH) {
      throw new CanvasSceneContractError("Canvas scene exceeds the JSON depth limit");
    }
    if (candidate === null || typeof candidate === "boolean") {
      return JSON.stringify(candidate);
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return JSON.stringify(candidate);
    }
    if (typeof candidate === "string") return JSON.stringify(candidate);
    if (typeof candidate !== "object" || candidate === null) {
      throw new CanvasSceneContractError("Canvas scene must contain only JSON values");
    }
    if (seen.has(candidate)) {
      throw new CanvasSceneContractError("Canvas scene must not be cyclic");
    }
    seen.add(candidate);
    try {
      const serialized = Array.isArray(candidate)
        ? `[${candidate.map((entry) => visit(entry, depth + 1)).join(",")}]`
        : `{${Object.keys(candidate)
            .sort()
            .map(
              (key) =>
                `${JSON.stringify(key)}:${visit(
                  (candidate as Readonly<Record<string, unknown>>)[key],
                  depth + 1,
                )}`,
            )
            .join(",")}}`;
      if (serialized.length <= MAX_PROJECTION_JSON_LENGTH) return serialized;
      throw new CanvasSceneContractError("Canvas scene exceeds the canonical JSON size limit");
    } finally {
      seen.delete(candidate);
    }
  };
  return visit(value, 0);
};

const hashString32 = (value: string, seed: number): string => {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

export const canvasSceneElementHash = (element: CanvasSceneElement): string => {
  const canonical = stableStringifyBlockPropertyJson(element);
  return [
    hashString32(canonical, 0x811c9dc5),
    hashString32(canonical, 0x9e3779b9),
    hashString32(canonical, 0x85ebca6b),
    hashString32(canonical, 0xc2b2ae35),
  ].join("");
};

const elementClock = (
  element: CanvasSceneElement,
): { readonly version: number; readonly versionNonce: number } => ({
  version: requireSafeInteger(element.version, `Canvas element ${String(element.id)}.version`, 1),
  versionNonce: requireSafeInteger(
    element.versionNonce,
    `Canvas element ${String(element.id)}.versionNonce`,
    0,
  ),
});

const normalizeRuntimeJson = (
  value: unknown,
  field: string,
  depth: number,
  state: { readonly seen: WeakSet<object>; nodes: number },
): unknown => {
  state.nodes += 1;
  if (state.nodes > MAX_ELEMENT_JSON_NODES) {
    throw new CanvasSceneContractError(`${field} exceeds the JSON node limit`);
  }
  if (depth > MAX_ELEMENT_JSON_DEPTH) {
    throw new CanvasSceneContractError(`${field} exceeds the JSON depth limit`);
  }
  if (value === null || typeof value !== "object") return value;
  if (state.seen.has(value)) {
    throw new CanvasSceneContractError(`${field} must not be cyclic`);
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        normalizeRuntimeJson(entry, `${field}[${index}]`, depth + 1, state),
      );
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanvasSceneContractError(`${field} must contain only plain JSON objects`);
    }
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      normalized[key] = normalizeRuntimeJson(entry, `${field}.${key}`, depth + 1, state);
    }
    return normalized;
  } finally {
    state.seen.delete(value);
  }
};

const canonicalizePageReference = (element: CanvasSceneElement): CanvasSceneElement => {
  const customData = element.customData;
  if (!isRecord(customData)) return element;
  if (customData.type !== "nodex-card" && customData.type !== "nodex-card-reference") {
    return element;
  }
  const targetBlockId = requireCanvasSceneIdentity(
    customData.targetBlockId ?? customData.cardId,
    `Canvas element ${String(element.id)}.customData.targetBlockId`,
  );
  const titleHint =
    typeof customData.titleHint === "string" ? customData.titleHint.slice(0, 512) : undefined;
  return {
    ...element,
    customData: {
      type: "nodex-card-reference",
      targetBlockId,
      ...(titleHint ? { titleHint } : {}),
    },
  };
};

export const canonicalizeCanvasSceneElement = (
  value: unknown,
  options: {
    readonly expectedId?: string;
    readonly runtime?: boolean;
  } = {},
): CanvasSceneElement => {
  const candidate = options.runtime
    ? normalizeRuntimeJson(value, "Canvas element", 0, {
        seen: new WeakSet<object>(),
        nodes: 0,
      })
    : value;
  const record = canonicalJsonRecord(candidate, "Canvas element");
  const id = requireCanvasSceneIdentity(record.id, "Canvas element.id");
  if (options.expectedId !== undefined && options.expectedId !== id) {
    throw new CanvasSceneContractError(
      `Canvas element map key ${options.expectedId} does not match payload ${id}`,
    );
  }
  elementClock(record);
  if (typeof record.isDeleted !== "boolean") {
    throw new CanvasSceneContractError(`Canvas element ${id}.isDeleted must be boolean`);
  }
  if (
    record.index !== undefined &&
    (typeof record.index !== "string" ||
      record.index.length === 0 ||
      record.index.length > MAX_CANVAS_SCENE_ORDER_KEY_LENGTH)
  ) {
    throw new CanvasSceneContractError(
      `Canvas element ${id}.index must be a bounded string when present`,
    );
  }
  return canonicalizePageReference(record);
};

export const chooseCanvasSceneElementWinner = (
  leftInput: CanvasSceneElement,
  rightInput: CanvasSceneElement,
): CanvasSceneElement => {
  const left = canonicalizeCanvasSceneElement(leftInput);
  const right = canonicalizeCanvasSceneElement(rightInput);
  if (left.id !== right.id) {
    throw new CanvasSceneContractError("Canvas element contenders must have the same id");
  }
  const leftClock = elementClock(left);
  const rightClock = elementClock(right);
  if (leftClock.version !== rightClock.version) {
    return leftClock.version > rightClock.version ? left : right;
  }
  if (leftClock.versionNonce !== rightClock.versionNonce) {
    return leftClock.versionNonce < rightClock.versionNonce ? left : right;
  }
  const leftHash = canvasSceneElementHash(left);
  const rightHash = canvasSceneElementHash(right);
  if (leftHash !== rightHash) return leftHash < rightHash ? left : right;
  const leftCanonical = stableStringifyBlockPropertyJson(left);
  const rightCanonical = stableStringifyBlockPropertyJson(right);
  return leftCanonical <= rightCanonical ? left : right;
};

export const canonicalizeCanvasSceneFile = (
  value: unknown,
  expectedId: string,
): CanvasSceneFile => {
  const record = canonicalJsonRecord(value, `Canvas file ${expectedId}`);
  const allowedKeys = new Set([
    "id",
    "mimeType",
    "source",
    "fileVersion",
    "defaultName",
    "created",
  ]);
  const unsupportedKey = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unsupportedKey) {
    throw new CanvasSceneContractError(
      `Canvas file ${expectedId} contains unsupported field ${unsupportedKey}`,
    );
  }
  const id = requireCanvasSceneIdentity(record.id, `Canvas file ${expectedId}.id`);
  if (id !== expectedId) {
    throw new CanvasSceneContractError(
      `Canvas file map key ${expectedId} does not match payload ${id}`,
    );
  }
  if (
    typeof record.mimeType !== "string" ||
    record.mimeType.length === 0 ||
    record.mimeType.length > 256
  ) {
    throw new CanvasSceneContractError(
      `Canvas file ${expectedId}.mimeType must be a bounded string`,
    );
  }
  const parsedSource = typeof record.source === "string" ? parseFileSource(record.source) : null;
  if (!parsedSource || record.source !== fileSource(parsedSource)) {
    throw new CanvasSceneContractError(
      `Canvas file ${expectedId}.source must be a canonical Library File URI`,
    );
  }
  const fileVersion = requireSafeInteger(
    record.fileVersion,
    `Canvas file ${expectedId}.fileVersion`,
    1,
  );
  const defaultName = record.defaultName;
  if (
    typeof defaultName !== "string" ||
    !defaultName ||
    defaultName !== defaultName.normalize("NFC") ||
    new TextEncoder().encode(defaultName).length > 255 ||
    /[\/\\<>:"|?*\u0000-\u001f\u007f]/u.test(defaultName) ||
    /[. ]$/u.test(defaultName) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(defaultName)
  ) {
    throw new CanvasSceneContractError(
      `Canvas file ${expectedId}.defaultName must be a portable canonical name`,
    );
  }
  if (
    record.created !== undefined &&
    (typeof record.created !== "number" ||
      !Number.isSafeInteger(record.created) ||
      record.created < 0)
  ) {
    throw new CanvasSceneContractError(
      `Canvas file ${expectedId}.created must be a non-negative safe integer`,
    );
  }
  return {
    id,
    mimeType: record.mimeType,
    source: record.source,
    fileVersion,
    defaultName,
    ...(record.created === undefined ? {} : { created: record.created }),
  };
};

export const pickPortableCanvasSceneAppState = (
  value: Readonly<Record<string, unknown>> | undefined,
): CanvasSceneAppState => {
  if (!value) return {};
  const candidate: Record<string, unknown> = {};
  for (const key of DURABLE_CANVAS_SCENE_APP_STATE_KEYS) {
    if (value[key] !== undefined) candidate[key] = value[key];
  }
  const durable = canonicalJsonRecord(candidate, "Canvas appState");
  if (durable.gridModeEnabled !== undefined && typeof durable.gridModeEnabled !== "boolean") {
    throw new CanvasSceneContractError("Canvas appState.gridModeEnabled must be boolean");
  }
  for (const key of ["gridSize", "gridStep"] as const) {
    const entry = durable[key];
    if (
      entry !== undefined &&
      entry !== null &&
      (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0)
    ) {
      throw new CanvasSceneContractError(
        `Canvas appState.${key} must be a positive number or null`,
      );
    }
  }
  if (
    durable.viewBackgroundColor !== undefined &&
    (typeof durable.viewBackgroundColor !== "string" || durable.viewBackgroundColor.length > 128)
  ) {
    throw new CanvasSceneContractError(
      "Canvas appState.viewBackgroundColor must be a bounded string",
    );
  }
  return durable;
};

export const isDurableCanvasSceneAppStateKey = (key: string): boolean =>
  durableAppStateKeys.has(key);

export const canvasSceneElementOrderKey = (
  element: CanvasSceneElement,
  fallbackOrdinal: number,
): string =>
  typeof element.index === "string" && element.index.length > 0
    ? element.index
    : `legacy:${fallbackOrdinal.toString(16).padStart(16, "0")}`;

const readPageReference = (element: CanvasSceneElement): CanvasScenePageReference | null => {
  const customData = element.customData;
  if (!isRecord(customData) || customData.type !== "nodex-card-reference") {
    return null;
  }
  const targetBlockId = requireCanvasSceneIdentity(
    customData.targetBlockId,
    `Canvas element ${String(element.id)}.customData.targetBlockId`,
  );
  const titleHint =
    typeof customData.titleHint === "string" ? customData.titleHint.slice(0, 512) : undefined;
  return {
    sourceElementId: element.id as string,
    targetBlockId,
    ...(titleHint ? { titleHint } : {}),
  };
};

const elementPlainText = (element: CanvasSceneElement): string => {
  if (element.isDeleted === true) return "";
  if (typeof element.text === "string") return element.text;
  const label = element.label;
  return isRecord(label) && typeof label.text === "string" ? label.text : "";
};

export const materializePortableCanvasScene = (input: {
  readonly elements: readonly unknown[];
  readonly appState?: Readonly<Record<string, unknown>>;
  readonly files?: Readonly<Record<string, unknown>>;
  readonly runtimeElements?: boolean;
}): PortableCanvasScene => {
  if (input.elements.length > MAX_CANVAS_SCENE_ELEMENTS) {
    throw new CanvasSceneContractError(
      `Canvas scene exceeds ${MAX_CANVAS_SCENE_ELEMENTS} elements`,
    );
  }
  const elements = input.elements.map((element) =>
    canonicalizeCanvasSceneElement(element, {
      runtime: input.runtimeElements ?? false,
    }),
  );
  const elementIds = elements.map((element) => element.id as string);
  if (new Set(elementIds).size !== elementIds.length) {
    throw new CanvasSceneContractError("Canvas scene repeats an element id");
  }
  const fileEntries = Object.entries(input.files ?? {});
  if (fileEntries.length > MAX_CANVAS_SCENE_FILES) {
    throw new CanvasSceneContractError(`Canvas scene exceeds ${MAX_CANVAS_SCENE_FILES} files`);
  }
  const files = Object.fromEntries(
    fileEntries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fileId, file]) => [fileId, canonicalizeCanvasSceneFile(file, fileId)]),
  );
  for (const element of elements) {
    if (
      element.isDeleted === true ||
      element.type !== "image" ||
      typeof element.fileId !== "string"
    ) {
      continue;
    }
    if (files[element.fileId]) continue;
    throw new CanvasSceneContractError(
      `Canvas image references missing managed file ${element.fileId}`,
    );
  }
  const appState = pickPortableCanvasSceneAppState(input.appState);
  const pageReferences = elements
    .filter((element) => element.isDeleted !== true)
    .map(readPageReference)
    .filter((reference): reference is CanvasScenePageReference => reference !== null);
  const plainText = elements
    .map(elementPlainText)
    .filter((text) => text.length > 0)
    .join("\n")
    .slice(0, MAX_CANVAS_SCENE_SHARED_TEXT_LENGTH);
  return {
    kind: CANVAS_SCENE_KIND,
    schemaVersion: CANVAS_SCENE_SCHEMA_VERSION,
    elements,
    appState,
    files,
    pageReferences,
    plainText,
    preview: plainText.replace(/\s+/gu, " ").trim().slice(0, 280),
  };
};

export const canonicalPortableCanvasSceneFingerprint = (scene: PortableCanvasScene): string =>
  canonicalStringifyCanvasScene({
    schemaVersion: scene.schemaVersion,
    elements: scene.elements,
    appState: scene.appState,
    files: scene.files,
    pageReferences: scene.pageReferences,
  });

const semanticElement = (element: CanvasSceneElement): CanvasSceneElement =>
  Object.fromEntries(
    Object.entries(element).filter(([key]) => key !== "version" && key !== "versionNonce"),
  ) as CanvasSceneElement;

export const canonicalPortableCanvasSceneSemanticFingerprint = (
  scene: PortableCanvasScene,
): string =>
  canonicalStringifyCanvasScene({
    schemaVersion: scene.schemaVersion,
    elements: scene.elements.filter((element) => element.isDeleted !== true).map(semanticElement),
    appState: scene.appState,
    files: scene.files,
  });

export const parsePortableCanvasScene = (value: unknown): PortableCanvasScene => {
  if (!isRecord(value)) {
    throw new CanvasSceneContractError("Canvas scene must be an object");
  }
  if (
    value.kind !== CANVAS_SCENE_KIND ||
    value.schemaVersion !== CANVAS_SCENE_SCHEMA_VERSION ||
    !Array.isArray(value.elements) ||
    !isRecord(value.appState) ||
    !isRecord(value.files) ||
    !Array.isArray(value.pageReferences) ||
    typeof value.plainText !== "string" ||
    typeof value.preview !== "string"
  ) {
    throw new CanvasSceneContractError("Canvas scene has invalid field shapes");
  }
  const derived = materializePortableCanvasScene({
    elements: value.elements,
    appState: value.appState,
    files: value.files,
  });
  if (canonicalStringifyCanvasScene(derived) === canonicalStringifyCanvasScene(value)) {
    return derived;
  }
  throw new CanvasSceneContractError("Canvas scene does not match its derived projection");
};

const deterministicVersionNonce = (restoreIdentity: string, elementId: string): number =>
  Number.parseInt(hashString32(`${restoreIdentity}\0${elementId}`, 0x811c9dc5), 16);

const nextElementVersion = (
  current: CanvasSceneElement | undefined,
  target: CanvasSceneElement,
): number => {
  const currentVersion = current ? elementClock(current).version : 0;
  const next = Math.max(currentVersion, elementClock(target).version) + 1;
  if (Number.isSafeInteger(next)) return next;
  throw new CanvasSceneContractError(
    `Canvas element ${String(target.id)} cannot advance beyond MAX_SAFE_INTEGER`,
  );
};

export const compilePortableCanvasSceneForwardRestore = (input: {
  readonly current: PortableCanvasScene;
  readonly target: PortableCanvasScene;
  readonly restoreIdentity: string;
}): CanvasSceneForwardRestorePlan => {
  const restoreIdentity = requireCanvasSceneIdentity(
    input.restoreIdentity,
    "Canvas restore identity",
  );
  const currentById = new Map(
    input.current.elements.map((element) => [element.id as string, element]),
  );
  const targetIds = new Set(input.target.elements.map((element) => element.id as string));
  const elementCandidates = input.target.elements.map((target) => {
    const elementId = target.id as string;
    return canonicalizeCanvasSceneElement({
      ...target,
      version: nextElementVersion(currentById.get(elementId), target),
      versionNonce: deterministicVersionNonce(restoreIdentity, elementId),
    });
  });
  for (const current of input.current.elements) {
    const elementId = current.id as string;
    if (targetIds.has(elementId)) continue;
    elementCandidates.push(
      canonicalizeCanvasSceneElement({
        ...current,
        version: nextElementVersion(current, current),
        versionNonce: deterministicVersionNonce(restoreIdentity, elementId),
        isDeleted: true,
      }),
    );
  }
  const files = Object.fromEntries(
    Object.entries(input.target.files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fileId, file]) => [fileId, canonicalizeCanvasSceneFile(file, fileId)]),
  );
  return {
    kind: "canvas_scene_forward_restore",
    restoreIdentity,
    targetSemanticFingerprint: canonicalPortableCanvasSceneSemanticFingerprint(input.target),
    elementCandidates,
    appState: pickPortableCanvasSceneAppState(input.target.appState),
    files,
    restoredElementIds: elementCandidates
      .map((element) => element.id as string)
      .sort((left, right) => left.localeCompare(right)),
  };
};
