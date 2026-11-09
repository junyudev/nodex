/**
 * Where a Space route leads, as far as its address says: the phone's own network (private LAN,
 * loopback and link-local addresses, `.local` and unqualified names), a tailnet (100.64.0.0/10,
 * Tailscale's IPv6 range and MagicDNS names) or anywhere else.
 */
type Reach = "local" | "tailnet" | "other";

const ipv4 = (host: string): readonly number[] | null => {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/u.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
};

const ipv4Reach = ([a = 0, b = 0]: readonly number[]): Reach =>
  a === 10 ||
  a === 127 ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 168) ||
  (a === 169 && b === 254)
    ? "local"
    : a === 100 && b >= 64 && b <= 127
      ? "tailnet"
      : "other";

const ipv6Reach = (address: string): Reach => {
  // An IPv4-mapped address, written dotted or, as a URL writes it, in hex (`::ffff:6440:102`).
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(address)?.[1];
  const octets = dotted ? ipv4(dotted) : null;
  if (octets) return ipv4Reach(octets);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (hex) {
    const [high, low] = [parseInt(hex[1] ?? "0", 16), parseInt(hex[2] ?? "0", 16)];
    return ipv4Reach([high >> 8, high & 255, low >> 8, low & 255]);
  }
  if (address === "::1" || /^fe[89ab][0-9a-f]?:/u.test(address)) return "local";
  if (address.startsWith("fd7a:115c:a1e0:")) return "tailnet";
  return /^f[cd][0-9a-f]{0,2}:/u.test(address) ? "local" : "other";
};

const reach = (route: string): Reach => {
  let hostname: string;
  try {
    hostname = new URL(route).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (hostname.startsWith("[")) return ipv6Reach(hostname.slice(1, -1));
  const octets = ipv4(hostname);
  if (octets) return ipv4Reach(octets);
  const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (!name.includes(".") || name.endsWith(".local")) return "local";
  return name.endsWith(".ts.net") ? "tailnet" : "other";
};

const rank: Record<Reach, number> = { local: 0, tailnet: 1, other: 2 };

/**
 * The order a phone tries a Space's routes in. The pin opens every route alike, so this is only a
 * preference: the phone's own network first, then the tailnet, then the rest, each in the order
 * given.
 */
export const orderRoutes = (routes: readonly string[]): string[] =>
  routes
    .map((route, index) => ({ route, index, rank: rank[reach(route)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ route }) => route);
