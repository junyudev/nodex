export interface NodexAccountPublicConfiguration {
  readonly issuer: string;
  readonly clientId: string;
}

export type NodexAccountConfiguration =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | ({ readonly kind: "ready" } & NodexAccountPublicConfiguration);

/** Credentials never come from deployment configuration. */
export const parseNodexAccountConfiguration = (
  input: Partial<NodexAccountPublicConfiguration> | null,
  allowLoopback = false,
): NodexAccountConfiguration => {
  const issuer = input?.issuer?.trim();
  const clientId = input?.clientId?.trim();
  if (!issuer && !clientId) return { kind: "absent" };
  if (!issuer || !clientId || clientId.length > 1024) return { kind: "invalid" };
  try {
    const url = new URL(issuer);
    if (
      (url.protocol !== "https:" &&
        !(allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return { kind: "invalid" };
    return { kind: "ready", issuer: url.origin, clientId };
  } catch {
    return { kind: "invalid" };
  }
};
