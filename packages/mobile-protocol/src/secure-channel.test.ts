import { equalBytes } from "@noble/ciphers/utils.js";
import { assert, expect, test } from "vite-plus/test";

import { NOISE_MAX_MESSAGE_BYTES, NOISE_TAG_BYTES, writeIkInitiation } from "./noise";
import {
  beginHandshake,
  CHANNEL_HANDSHAKE_CONNECT,
  CHANNEL_HANDSHAKE_PAIR,
  CHANNEL_MAX_MESSAGE_BYTES,
  ChannelHandshakeError,
  generateStaticKeyPair,
  NOISE_KEY_BYTES,
  respondToHandshake,
  type ChannelHandshakeFailure,
  type SecureChannel,
} from "./secure-channel";

const bytes = (seed: number) => (length: number) => new Uint8Array(length).fill(seed);
const host = generateStaticKeyPair(bytes(11));
const device = generateStaticKeyPair(bytes(22));
const pairingPsk = bytes(55)(NOISE_KEY_BYTES);
const empty = new Uint8Array(0);
const maxFragmentBytes = NOISE_MAX_MESSAGE_BYTES - NOISE_TAG_BYTES - 1;

const initialPayload = Uint8Array.of(4, 8, 15);
const wirePrologue = (pattern: number) =>
  Uint8Array.of(...Array.from("Nodex Mobile Channel v1", (char) => char.charCodeAt(0)), pattern);

const start = (pairing: boolean, hostPublicKey = host.publicKey, seed = 33) =>
  beginHandshake({
    hostPublicKey,
    device,
    psk: pairing ? pairingPsk : undefined,
    payload: initialPayload,
    randomBytes: bytes(seed),
  });

const respond = (message: Uint8Array, offer: Uint8Array | null, seed = 44) =>
  respondToHandshake({ message, host, pairingPsk: offer, randomBytes: bytes(seed) });

const expectHandshakeFailure = (attempt: () => unknown, reason: ChannelHandshakeFailure) => {
  expect(attempt).toThrow(expect.objectContaining({ name: "ChannelHandshakeError", reason }));
};

const connect = (pairing = false) => {
  const initiator = start(pairing);
  const responder = respond(initiator.message, pairing ? pairingPsk : null);
  const accepted = responder.accept(Uint8Array.of(16, 23, 42));
  return {
    initiator,
    responder,
    desktop: accepted.channel,
    phone: initiator.finish(accepted.reply).channel,
  };
};

const expectDelivered = (sender: SecureChannel, receiver: SecureChannel, payload: Uint8Array) => {
  const frames = sender.seal(payload);
  expect(frames).toHaveLength(Math.max(1, Math.ceil(payload.length / maxFragmentBytes)));
  for (const [index, frame] of frames.entries()) {
    expect(frame.length).toBeLessThanOrEqual(NOISE_MAX_MESSAGE_BYTES);
    const opened = receiver.open(frame);
    if (index < frames.length - 1) {
      expect(opened).toBeNull();
      continue;
    }
    assert(opened);
    expect(equalBytes(opened, payload)).toBe(true);
  }
};

test.each([
  { name: "connect", pairing: false, pattern: CHANNEL_HANDSHAKE_CONNECT },
  { name: "pair", pairing: true, pattern: CHANNEL_HANDSHAKE_PAIR },
])(
  "round trips a $name handshake and fragmented messages in both directions",
  ({ pairing, pattern }) => {
    const { initiator, responder, desktop, phone } = connect(pairing);
    expect(initiator.message[0]).toBe(pattern);
    expect(responder.pairing).toBe(pairing);
    expect(responder.remoteStaticKey).toEqual(device.publicKey);
    expect(responder.payload).toEqual(Uint8Array.of(4, 8, 15));
    expect(phone.handshakeHash).toEqual(desktop.handshakeHash);
    expectDelivered(phone, desktop, new Uint8Array(2 * maxFragmentBytes).fill(19));
    expectDelivered(desktop, phone, new Uint8Array(2 * maxFragmentBytes + 45).fill(25));
    expectDelivered(phone, desktop, empty);
    expectDelivered(desktop, phone, Uint8Array.of(1, 2, 3));
  },
);

test.each([false, true])("binds the Nodex label and pattern byte (pairing %s)", (pairing) => {
  const wire = start(pairing).message;
  const pattern = pairing ? CHANNEL_HANDSHAKE_PAIR : CHANNEL_HANDSHAKE_CONNECT;
  const noise = writeIkInitiation(
    host.publicKey,
    device,
    pairing ? pairingPsk : undefined,
    initialPayload,
    bytes(33),
    wirePrologue(pattern),
  );

  expect(wire.subarray(1)).toEqual(noise.message);
  const relabeled = wire.slice();
  relabeled[0] = pairing ? CHANNEL_HANDSHAKE_CONNECT : CHANNEL_HANDSHAKE_PAIR;
  expectHandshakeFailure(() => respond(relabeled, pairingPsk), "authentication-failed");
});

test("pairs and reconnects with the same device identity and a fresh channel", () => {
  const paired = connect(true);
  expectDelivered(paired.phone, paired.desktop, Uint8Array.of(1));
  expectDelivered(paired.desktop, paired.phone, Uint8Array.of(2));

  const initiator = start(false, host.publicKey, 34);
  const responder = respond(initiator.message, null, 45);
  expect(responder.remoteStaticKey).toEqual(paired.responder.remoteStaticKey);
  const reconnected = responder.accept(empty);
  const { channel: phone } = initiator.finish(reconnected.reply);
  expect(phone.handshakeHash).not.toEqual(paired.phone.handshakeHash);
  expectDelivered(phone, reconnected.channel, Uint8Array.of(3));
  expectDelivered(reconnected.channel, phone, Uint8Array.of(4));
});

test("classifies malformed first messages and unavailable pairing offers", () => {
  const first = start(true).message;
  expectHandshakeFailure(() => respond(first, null), "pairing-unavailable");
  const unknownPattern = first.slice();
  unknownPattern[0] = 0xff;
  for (const malformed of [
    empty,
    first.subarray(0, 32),
    unknownPattern,
    new Uint8Array(65_537).fill(1),
  ]) {
    expectHandshakeFailure(() => respond(malformed, pairingPsk), "malformed");
  }
});

test("rejects a wrong PSK and a bad tag with the same failure", () => {
  const first = start(true).message;
  const wrongPsk = bytes(56)(NOISE_KEY_BYTES);
  const tampered = first.slice();
  tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
  for (const attempt of [() => respond(first, wrongPsk), () => respond(tampered, pairingPsk)]) {
    expect(attempt).toThrow(ChannelHandshakeError);
    expectHandshakeFailure(attempt, "authentication-failed");
  }
});

test("pins the Host key and rejects invalid static public keys", () => {
  const otherHost = generateStaticKeyPair(bytes(12));
  expectHandshakeFailure(
    () => respond(start(false, otherHost.publicKey).message, null),
    "authentication-failed",
  );
  const alias = host.publicKey.slice();
  alias[31] = (alias[31] ?? 0) | 0x80;
  for (const invalidKey of [new Uint8Array(31), new Uint8Array(32), alias]) {
    expect(() => start(false, invalidKey)).toThrow();
  }
});

test("finish rejects a valid reply from a different Host", () => {
  const otherHost = generateStaticKeyPair(bytes(12));
  const wrongInitiation = start(false, otherHost.publicKey);
  const { reply } = respondToHandshake({
    message: wrongInitiation.message,
    host: otherHost,
    pairingPsk: null,
    randomBytes: bytes(44),
  }).accept(empty);

  expect(() => start(false).finish(reply)).toThrow();
  expect(() => wrongInitiation.finish(reply)).not.toThrow();
});

test("rejects a low-order initiator ephemeral key", () => {
  const first = start(false).message;
  first.fill(0, 1, 1 + NOISE_KEY_BYTES);
  expectHandshakeFailure(() => respond(first, null), "authentication-failed");
});

test("rejects a tampered handshake reply and consumes the handshake attempt", () => {
  const initiator = start(false);
  const responder = respond(initiator.message, null);
  const { reply } = responder.accept(empty);
  const tampered = reply.slice();
  tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
  expect(() => initiator.finish(tampered)).toThrow();
  expect(() => initiator.finish(reply)).toThrow();
  expect(() => responder.accept(empty)).toThrow();
});

test("closes on tampered, reordered, replayed or truncated frames", () => {
  const message = new Uint8Array(maxFragmentBytes + 1);
  for (const corruption of ["tamper", "reorder", "replay", "truncate"]) {
    const { phone, desktop } = connect();
    const [first, second] = phone.seal(message);
    assert(first && second);
    if (corruption === "tamper") {
      const altered = first.slice();
      altered[0] = (altered[0] ?? 0) ^ 1;
      expect(() => desktop.open(altered)).toThrow();
    } else if (corruption === "reorder") {
      expect(() => desktop.open(second)).toThrow();
    } else if (corruption === "replay") {
      expect(desktop.open(first)).toBeNull();
      expect(() => desktop.open(first)).toThrow();
    } else {
      expect(() => desktop.open(first.subarray(0, -1))).toThrow();
    }
    expect(() => desktop.open(second)).toThrow();
  }
});

test.each([false, true])(
  "a replayed first message cannot authenticate transport (pairing %s)",
  (pairing) => {
    const initiator = start(pairing);
    const offer = pairing ? pairingPsk : null;
    const original = respond(initiator.message, offer).accept(empty);
    const { channel: phone } = initiator.finish(original.reply);
    const [recordedFrame] = phone.seal(Uint8Array.of(42));
    assert(recordedFrame);
    expect(original.channel.open(recordedFrame)).toEqual(Uint8Array.of(42));

    const replay = respond(initiator.message, offer, 45).accept(empty);
    expect(replay.channel.handshakeHash).not.toEqual(original.channel.handshakeHash);
    expect(() => replay.channel.open(recordedFrame)).toThrow();
  },
);

test("delivers messages at and around the frame boundary", () => {
  const { desktop, phone } = connect();
  for (const length of [maxFragmentBytes - 1, maxFragmentBytes, maxFragmentBytes + 1]) {
    expectDelivered(phone, desktop, new Uint8Array(length).fill(23));
  }
});

test("rejects oversized outbound messages before advancing the nonce", () => {
  const { desktop, phone } = connect();
  expect(() => phone.seal(new Uint8Array(CHANNEL_MAX_MESSAGE_BYTES + 1))).toThrow(/too large/u);
  expectDelivered(phone, desktop, new Uint8Array(CHANNEL_MAX_MESSAGE_BYTES).fill(41));
});

test("rejects an oversized inbound frame before decrypting", () => {
  const { desktop } = connect();
  expect(() => desktop.open(new Uint8Array(NOISE_MAX_MESSAGE_BYTES + 1))).toThrow(/malformed/iu);
});

const rawConnect = () => {
  const initiator = writeIkInitiation(
    host.publicKey,
    device,
    undefined,
    empty,
    bytes(33),
    wirePrologue(CHANNEL_HANDSHAKE_CONNECT),
  );
  const first = new Uint8Array(initiator.message.length + 1);
  first[0] = CHANNEL_HANDSHAKE_CONNECT;
  first.set(initiator.message, 1);
  const { channel, reply } = respond(first, null).accept(empty);
  return { channel, send: initiator.finish(reply).transport.send };
};

test.each([Uint8Array.of(2), Uint8Array.of(1, 42)])(
  "rejects an authenticated frame with an invalid flag or continuation size (%s)",
  (plaintext) => {
    const { channel, send } = rawConnect();
    expect(() => channel.open(send.seal(plaintext))).toThrow(/malformed/iu);
  },
);

test("rejects an authenticated message that exceeds the reassembly limit", () => {
  const { channel, send } = rawConnect();
  const continuation = new Uint8Array(1 + maxFragmentBytes);
  continuation[0] = 1;
  const continuationCount = Math.floor(CHANNEL_MAX_MESSAGE_BYTES / maxFragmentBytes);
  for (let index = 0; index < continuationCount; index += 1) {
    expect(channel.open(send.seal(continuation))).toBeNull();
  }
  const final = new Uint8Array(2 + (CHANNEL_MAX_MESSAGE_BYTES % maxFragmentBytes));
  expect(() => channel.open(send.seal(final))).toThrow(/too large/u);
});
