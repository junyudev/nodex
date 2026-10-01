import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const COMPUTER_USE_CONFIG_DIRECTORY = "computer-use";
const COMPUTER_USE_CONFIG_FILENAME = "config.json";
const DEFAULT_ACCENT_COLOR = "#339cff";
const DEFAULT_LOCALE = "en";
const DEFAULT_STRINGS = {
  escToCancel: "Esc to cancel",
  usingComputer: "Nodex is using your computer",
} as const;
const ESC_TO_CANCEL_LOCALE_KEY = "computerUseOverlay.escToCancel";
const USING_COMPUTER_LOCALE_KEY = "computerUseOverlay.usingComputer";

export interface ComputerUseRuntimeConfig {
  readonly accentColor: string;
  readonly direction: "ltr" | "rtl";
  readonly locale: string;
  readonly strings: {
    readonly escToCancel: string;
    readonly usingComputer: string;
  };
}

export interface ComputerUseRuntimeConfigInput {
  readonly accentColor?: string | null;
  readonly locale?: string | null;
  readonly localesDirectory?: string | null;
  readonly strings?: Partial<ComputerUseRuntimeConfig["strings"]>;
}

export type ComputerUseRuntimeConfigWriteInput = ComputerUseRuntimeConfigInput & {
  readonly runtimeStateHome: string;
};

/** Keep the native socket Profile-scoped and below macOS's Unix socket path limit. */
export function computerUseNativePipePath(runtimeStateHome: string): string {
  const profileKey = createHash("sha256").update(path.resolve(runtimeStateHome)).digest("hex");
  return path.join("/tmp", `nodex-cua-${process.getuid?.() ?? "user"}`, `${profileKey}.sock`);
}

function nonEmptyString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function resolveDirection(locale: string): "ltr" | "rtl" {
  try {
    const intlLocale = new Intl.Locale(locale.replaceAll("_", "-"));
    const textInfo =
      Reflect.get(intlLocale, "textInfo") ??
      Reflect.get(intlLocale, "getTextInfo")?.call(intlLocale);
    return Reflect.get(textInfo ?? {}, "direction") === "rtl" ? "rtl" : "ltr";
  } catch {
    return "ltr";
  }
}

function readLocaleCatalog(
  localesDirectory: string | null | undefined,
  locale: string,
): Record<string, unknown> | null {
  const directory = nonEmptyString(localesDirectory);
  if (!directory) return null;
  const normalizedLocale = locale.replaceAll("_", "-");
  const language = normalizedLocale.split("-")[0];
  const candidates = [
    path.join(directory, `${normalizedLocale}.json`),
    ...(language && language !== normalizedLocale
      ? [path.join(directory, `${language}.json`)]
      : []),
  ];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the language fallback or the built-in English strings.
    }
  }
  return null;
}

function localizedString(
  catalog: Record<string, unknown> | null,
  key: string,
  configuredValue: string | null | undefined,
  fallback: string,
): string {
  const configured = nonEmptyString(configuredValue);
  if (configured) return configured;
  const catalogValue = catalog?.[key];
  return nonEmptyString(typeof catalogValue === "string" ? catalogValue : null) ?? fallback;
}

export function buildComputerUseRuntimeConfig(
  input: ComputerUseRuntimeConfigInput = {},
): ComputerUseRuntimeConfig {
  const locale = nonEmptyString(input.locale) ?? DEFAULT_LOCALE;
  const catalog = readLocaleCatalog(input.localesDirectory, locale);
  const accentColor = /^#[0-9a-fA-F]{6}$/u.test(input.accentColor ?? "")
    ? input.accentColor!
    : DEFAULT_ACCENT_COLOR;
  return {
    accentColor,
    direction: resolveDirection(locale),
    locale,
    strings: {
      escToCancel: localizedString(
        catalog,
        ESC_TO_CANCEL_LOCALE_KEY,
        input.strings?.escToCancel,
        DEFAULT_STRINGS.escToCancel,
      ),
      usingComputer: localizedString(
        catalog,
        USING_COMPUTER_LOCALE_KEY,
        input.strings?.usingComputer,
        DEFAULT_STRINGS.usingComputer,
      ),
    },
  };
}

async function writeConfigAtomically(
  directory: string,
  configPath: string,
  config: ComputerUseRuntimeConfig,
): Promise<string> {
  const temporaryPath = path.join(
    directory,
    `${COMPUTER_USE_CONFIG_FILENAME}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config)}\n`, "utf8");
    await rename(temporaryPath, configPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return configPath;
}

/** Atomic filesystem operation; the owning ComputerUseRuntime serializes mutations. */
export function writeComputerUseRuntimeConfig(
  input: ComputerUseRuntimeConfigWriteInput,
): Promise<string> {
  const directory = path.join(path.resolve(input.runtimeStateHome), COMPUTER_USE_CONFIG_DIRECTORY);
  const configPath = path.join(directory, COMPUTER_USE_CONFIG_FILENAME);
  return writeConfigAtomically(directory, configPath, buildComputerUseRuntimeConfig(input));
}
