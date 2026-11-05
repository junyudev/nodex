import { isIP } from "node:net";

const ipv4Octets = (address: string): readonly number[] | null => {
  if (isIP(address) === 4) return address.split(".").map(Number);
  if (isIP(address) !== 6) return null;
  const normalized = new URL(`http://[${address}]/`).hostname;
  const mapped = /^\[::ffff:([\da-f]+):([\da-f]+)\]$/u.exec(normalized);
  if (!mapped) return null;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255];
};

const addressKind = (address: string) => {
  if (
    address === "::1" ||
    (!address.includes("%") &&
      isIP(address) === 6 &&
      new URL(`http://[${address}]/`).hostname === "[::1]")
  )
    return "loopback";
  // Scope-qualified IPv6 is not eligible for this IPv4 listener.
  if (address.includes("%")) return null;
  const octets = ipv4Octets(address);
  if (!octets) return null;
  const [a, b] = octets;
  if (a === 127) return "loopback";
  if (a === 100 && b! >= 64 && b! <= 127) return "tailnet";
  if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)) return "lan";
  if (a === 169 && b === 254) return "linkLocal";
  return null;
};

/** The name a phone shows for this computer, without the network's `.local` suffix. */
export const mobileHostName = (hostname: string): string => hostname.replace(/\.local$/iu, "");

export const isPrivateMobilePeer = (address: string | undefined): boolean =>
  address !== undefined && addressKind(address) !== null;

export interface MobileNetworkAddress {
  readonly address: string;
  readonly family: string;
  readonly internal: boolean;
}

export const mobileRoutes = (
  interfaces: Record<string, readonly MobileNetworkAddress[] | undefined>,
  port: number,
  development: boolean,
): readonly string[] => {
  const lan = new Set<string>();
  const tailnet = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    if (
      /^(?:docker|vboxnet|vmnet|veth|bridge|br-|awdl|llw|virbr|podman|cni|flannel|ham|zt|tap|vetun|vEthernet)/iu.test(
        name,
      )
    )
      continue;
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      const kind = addressKind(entry.address);
      if (kind === "tailnet") tailnet.add(entry.address);
      if (!/^(?:utun|tun|wg|tailscale)/iu.test(name) && (kind === "lan" || kind === "linkLocal"))
        lan.add(entry.address);
    }
  }
  return [...lan, ...tailnet, ...(development ? ["127.0.0.1"] : [])].map(
    (address) => `ws://${address}:${port}/mobile`,
  );
};
