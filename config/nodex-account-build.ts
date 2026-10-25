import { z } from "zod";
import {
  parseNodexAccountConfiguration,
  type NodexAccountPublicConfiguration,
} from "../src/shared/nodex-account-configuration";
import productionConfiguration from "./nodex-account-production.json";

export const NODEX_ACCOUNT_BUILD_VARIABLES = [
  "NODEX_BUILD_CLERK_ISSUER",
  "NODEX_BUILD_CLERK_CLIENT_ID",
] as const;

const configurationSchema = z
  .object({ issuer: z.string(), clientId: z.string() })
  .strict()
  .nullable();

/** Only explicit build inputs can become defaults in a distributed Desktop app. */
export const resolveNodexAccountBuildConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
  defaults: unknown = productionConfiguration,
): NodexAccountPublicConfiguration | null => {
  const overridden = NODEX_ACCOUNT_BUILD_VARIABLES.some((key) => environment[key] !== undefined);
  const input = overridden
    ? {
        issuer: environment.NODEX_BUILD_CLERK_ISSUER,
        clientId: environment.NODEX_BUILD_CLERK_CLIENT_ID,
      }
    : configurationSchema.parse(defaults);
  const configuration = parseNodexAccountConfiguration(input);
  if (configuration.kind === "absent") return null;
  if (
    configuration.kind === "invalid" ||
    new URL(configuration.issuer).hostname.endsWith(".clerk.accounts.dev")
  )
    throw new Error(
      "Bundled Nodex account configuration requires a production HTTPS issuer and public OAuth client ID.",
    );
  return { issuer: configuration.issuer, clientId: configuration.clientId };
};
