import { getIntl, type IntlShape } from "@/lib/i18n";
import {
  PROVIDER_KEY_REGION_MESSAGES,
  providerKeyBaseUrl,
  providerKeyPreset,
  providerKeyTarget,
  type ProviderKeyConnection,
} from "../../../shared/provider-keys";

const modelCount = (count: number, intl: IntlShape) =>
  intl.formatMessage(
    {
      id: "providerKeys.providerKeysModel.modelCount",
      defaultMessage: "{count, plural, one {# model} other {# models}}",
    },
    { count },
  );

const keyHint = (hint: string) => `••••${hint}`;

/**
 * A connection's secondary line: what is left to spend, what it offers, which key, and where it
 * sends requests.
 */
export function providerKeyDetail(
  connection: ProviderKeyConnection,
  intl: IntlShape = getIntl(),
  balance: string | null = null,
): string {
  const preset = providerKeyPreset(connection.preset);
  const place =
    connection.preset === "custom"
      ? hostOf(providerKeyBaseUrl(providerKeyTarget(connection)))
      : preset.endpoints.length > 1
        ? connection.endpoint &&
          intl.formatMessage(PROVIDER_KEY_REGION_MESSAGES[connection.endpoint])
        : null;
  return [
    balance,
    modelCount(connection.models.length, intl),
    connection.keyHint ? keyHint(connection.keyHint) : null,
    place,
  ]
    .filter(Boolean)
    .join(" · ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What the collapsed API keys card says: the providers by name, or how many when there are many. */
export function providerKeysSummary(
  connections: readonly ProviderKeyConnection[] | null,
  intl: IntlShape = getIntl(),
): string | null {
  if (!connections) return null;
  if (connections.length === 0)
    return intl.formatMessage({
      id: "providerKeys.providerKeysModel.notSetUp",
      defaultMessage: "Not set up",
    });
  const on = connections.filter(({ enabled }) => enabled);
  if (on.length === 0)
    return connections.length === 1
      ? intl.formatMessage({ id: "providerKeys.providerKeysModel.off", defaultMessage: "Off" })
      : intl.formatMessage(
          {
            id: "providerKeys.providerKeysModel.keysOff",
            defaultMessage: "{count} keys · Off",
          },
          { count: connections.length },
        );
  if (on.length <= 2)
    return intl.formatList(
      on.map(({ displayName }) => displayName),
      { type: "conjunction", style: "narrow" },
    );
  return intl.formatMessage(
    { id: "providerKeys.providerKeysModel.keyCount", defaultMessage: "{count} keys" },
    { count: on.length },
  );
}

/** The ready line for a connection in setup. */
export const providerKeyReadyDetail = (
  connection: ProviderKeyConnection,
  intl: IntlShape = getIntl(),
): string =>
  connection.keyHint
    ? `${modelCount(connection.models.length, intl)} · ${keyHint(connection.keyHint)}`
    : modelCount(connection.models.length, intl);
