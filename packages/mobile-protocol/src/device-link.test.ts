import { expect, test } from "vite-plus/test";
import { encodeDeviceLink, parseDeviceLinkUri, type DeviceLinkOffer } from "./device-link";

const offer: DeviceLinkOffer = {
  space_id: "space:a",
  space_name: "研发 🖥️",
  member_id: "member:bob",
  fingerprint: "ab".repeat(32),
  routes: ["https://192.168.1.10:8443", "https://host.local:8443"],
  code: "secret-link",
  expires_at: 1794000000,
};
test("a versioned link retains the exact Space, Member, certificate and expiry", () => {
  expect(parseDeviceLinkUri(` ${encodeDeviceLink(offer)}\n`)).toEqual(offer);
});
test.each([
  "nodex-mobile://pair#abc",
  "nodex-mobile://link#A",
  "nodex-mobile://link#++++",
  `nodex-mobile://link#${"a".repeat(32768)}`,
])("rejects malformed links without a compatibility decoder: %s", (uri) => {
  expect(parseDeviceLinkUri(uri)).toBeNull();
});
test.each([
  "http://192.168.1.10:8443",
  "https://user:secret@host.local",
  "https://host.local/path",
  "https://host.local/?token=secret",
  "https://host.local/#fragment",
])("rejects routes that cannot authenticate before enrollment: %s", (route) => {
  expect(() => encodeDeviceLink({ ...offer, routes: [route] })).toThrow();
});
test("unknown revisions and invalid pins cannot become an enrollment", () => {
  const future = encodeDeviceLink(offer).replace("eyJ2ZXJzaW9uIjox", "eyJ2ZXJzaW9uIjoy");
  expect(future).not.toBe(encodeDeviceLink(offer));
  expect(parseDeviceLinkUri(future)).toBeNull();
  expect(() => encodeDeviceLink({ ...offer, fingerprint: "not-a-pin" })).toThrow();
});

test("an offer cannot encode a link larger than the phone can accept", () => {
  expect(() =>
    encodeDeviceLink({
      ...offer,
      routes: Array.from({ length: 32 }, () => `https://${"a".repeat(1000)}.local`),
    }),
  ).toThrow();
});
