const PREFIX = "provider-key:";

/** The Settings > Agents anchor of one API key connection. */
export const providerKeyAnchor = (connectionId: string) => `${PREFIX}${connectionId}`;

export const isProviderKeyAnchor = (anchor: string) => anchor.startsWith(PREFIX);

export const providerKeyConnectionOfAnchor = (anchor: string | null | undefined) =>
  anchor && isProviderKeyAnchor(anchor) ? anchor.slice(PREFIX.length) : null;
