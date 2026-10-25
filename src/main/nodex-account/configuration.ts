import {
  parseNodexAccountConfiguration,
  type NodexAccountPublicConfiguration,
} from "../../shared/nodex-account-configuration";

declare const __NODEX_ACCOUNT_CONFIGURATION__: NodexAccountPublicConfiguration | null;

/** Runtime overrides replace the whole pair so development and production never mix. */
export const resolveNodexAccountConfiguration = (host: {
  readonly isPackaged: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
}) => {
  const environment = host.environment;
  const overridden =
    environment.NODEX_CLERK_ISSUER !== undefined || environment.NODEX_CLERK_CLIENT_ID !== undefined;
  if (overridden)
    return parseNodexAccountConfiguration(
      {
        issuer: environment.NODEX_CLERK_ISSUER,
        clientId: environment.NODEX_CLERK_CLIENT_ID,
      },
      !host.isPackaged && environment.NODEX_TEST_CLERK_LOOPBACK === "1",
    );
  if (!host.isPackaged || typeof __NODEX_ACCOUNT_CONFIGURATION__ === "undefined")
    return { kind: "absent" } as const;
  return parseNodexAccountConfiguration(__NODEX_ACCOUNT_CONFIGURATION__);
};
