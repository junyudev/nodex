/**
 * The encrypted channel between a phone and a Desktop Host. It runs over any ordered, message
 * preserving transport (a WebSocket today) and proves both ends' identities on every connection, so
 * a route's address and network carry no trust.
 *
 * Pairing uses Noise_IKpsk1_25519_ChaChaPoly_SHA256 with the one-time secret from the QR code as
 * the PSK, so the Host verifies the secret on the first message. Later connections use
 * Noise_IK_25519_ChaChaPoly_SHA256, where the phone's static key is its device identity.
 */

import { concatBytes } from "@noble/ciphers/utils.js";
import {
  IK_FIRST_MESSAGE_OVERHEAD,
  NOISE_MAX_MESSAGE_BYTES,
  NOISE_TAG_BYTES,
  readIkInitiation,
  writeIkInitiation,
  type NoiseTransport,
  type StaticKeyPair,
} from "./noise";

export { generateStaticKeyPair, NOISE_KEY_BYTES, type StaticKeyPair } from "./noise";

/** The first transport message carries this pattern byte, also bound into the Noise prologue. */
export const CHANNEL_HANDSHAKE_CONNECT = 0x01;
export const CHANNEL_HANDSHAKE_PAIR = 0x02;

/** Largest application message after reassembly. */
export const CHANNEL_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

/** WebSocket close codes a Host sends. These are unauthenticated hints, never authority. */
export const CHANNEL_CLOSE = {
  unknownDevice: 4401,
  pairingRejected: 4403,
  revoked: 4410,
  protocolMismatch: 4426,
  overloaded: 4429,
} as const;

/** Encrypts and decrypts application messages after a completed handshake. */
export interface SecureChannel {
  /**
   * Seals an application message into ordered transport frames of up to 65,535 bytes each.
   * Every continued frame carries 65,518 application bytes.
   */
  readonly seal: (message: Uint8Array) => readonly Uint8Array[];
  /**
   * Opens one frame. Returns the completed message or null while awaiting more frames.
   * A malformed, inauthentic or oversized frame permanently fails the channel.
   */
  readonly open: (frame: Uint8Array) => Uint8Array | null;
  /** Binds the session for logging and confirmation; equal on both ends. */
  readonly handshakeHash: Uint8Array;
}

export interface InitiatorHandshake {
  /** The first transport message, including the leading pattern byte. */
  readonly message: Uint8Array;
  /** Completes with the Host's reply; throws if it is not the expected Host. */
  readonly finish: (reply: Uint8Array) => { readonly channel: SecureChannel };
}

export interface ResponderHandshake {
  /** The verified static public key of the phone. */
  readonly remoteStaticKey: Uint8Array;
  /** The first message's decrypted payload. It can be replayed with the original first message. */
  readonly payload: Uint8Array;
  /** Whether the phone used the pairing pattern. */
  readonly pairing: boolean;
  /**
   * Produces the reply and the channel after the Host checks `remoteStaticKey`. For pairing, the
   * first message authenticates under the PSK. Wait for authenticated transport data before
   * granting authority or acting on the first payload.
   */
  readonly accept: (payload: Uint8Array) => {
    readonly reply: Uint8Array;
    readonly channel: SecureChannel;
  };
}

export interface BeginHandshakeInput {
  readonly hostPublicKey: Uint8Array;
  readonly device: StaticKeyPair;
  /** The pairing secret. Present only while pairing. */
  readonly psk?: Uint8Array;
  readonly payload: Uint8Array;
  /** Supplies fresh cryptographically secure bytes. */
  readonly randomBytes: (length: number) => Uint8Array;
}

export interface RespondToHandshakeInput {
  /** The first transport message, including the leading pattern byte. */
  readonly message: Uint8Array;
  readonly host: StaticKeyPair;
  /** The current one-time pairing secret, or null when no pairing offer is open. */
  readonly pairingPsk: Uint8Array | null;
  /** Supplies fresh cryptographically secure bytes. */
  readonly randomBytes: (length: number) => Uint8Array;
}

export type ChannelHandshakeFailure = "malformed" | "pairing-unavailable" | "authentication-failed";

export class ChannelHandshakeError extends Error {
  constructor(readonly reason: ChannelHandshakeFailure) {
    super(reason);
    this.name = "ChannelHandshakeError";
  }
}

const CHANNEL_LABEL = Uint8Array.from("Nodex Mobile Channel v1", (char) => char.charCodeAt(0));
const channelPrologue = (pattern: number): Uint8Array =>
  concatBytes(CHANNEL_LABEL, Uint8Array.of(pattern));

const FINAL = 0;
const CONTINUATION = 1;
const MAX_FRAGMENT_BYTES = NOISE_MAX_MESSAGE_BYTES - NOISE_TAG_BYTES - 1;

/** Each plaintext frame starts with its final/continuation flag. Continuations are full-sized. */
const secureChannel = ({ send, receive, handshakeHash }: NoiseTransport): SecureChannel => {
  let pending: Uint8Array[] = [];
  let failed = false;

  return {
    handshakeHash,
    seal(message) {
      if (failed) throw new Error("Secure channel failed");
      if (message.length > CHANNEL_MAX_MESSAGE_BYTES) {
        throw new Error("Secure channel message is too large");
      }
      const frames: Uint8Array[] = [];
      for (let offset = 0; ; offset += MAX_FRAGMENT_BYTES) {
        const end = Math.min(offset + MAX_FRAGMENT_BYTES, message.length);
        const final = end === message.length;
        const plaintext = new Uint8Array(1 + end - offset);
        plaintext[0] = final ? FINAL : CONTINUATION;
        plaintext.set(message.subarray(offset, end), 1);
        frames.push(send.seal(plaintext));
        if (final) return frames;
      }
    },
    open(frame) {
      if (failed) throw new Error("Secure channel failed");
      try {
        if (frame.length <= NOISE_TAG_BYTES || frame.length > NOISE_MAX_MESSAGE_BYTES) {
          throw new Error("Malformed secure channel frame");
        }
        const plaintext = receive.open(frame);
        const flag = plaintext[0];
        const fragment = plaintext.subarray(1);
        if (flag !== FINAL && (flag !== CONTINUATION || fragment.length !== MAX_FRAGMENT_BYTES)) {
          throw new Error("Malformed secure channel continuation");
        }
        if (pending.length * MAX_FRAGMENT_BYTES + fragment.length > CHANNEL_MAX_MESSAGE_BYTES) {
          throw new Error("Secure channel message is too large");
        }
        if (flag === CONTINUATION) {
          pending.push(fragment);
          return null;
        }
        if (pending.length === 0) return fragment;
        const message = concatBytes(...pending, fragment);
        pending = [];
        return message;
      } catch (error) {
        failed = true;
        pending = [];
        throw error;
      }
    },
  };
};

/** Starts a connection from the phone. */
export const beginHandshake = ({
  hostPublicKey,
  device,
  psk,
  payload,
  randomBytes,
}: BeginHandshakeInput): InitiatorHandshake => {
  const pattern = psk === undefined ? CHANNEL_HANDSHAKE_CONNECT : CHANNEL_HANDSHAKE_PAIR;
  const handshake = writeIkInitiation(
    hostPublicKey,
    device,
    psk,
    payload,
    randomBytes,
    channelPrologue(pattern),
  );
  return {
    message: concatBytes(Uint8Array.of(pattern), handshake.message),
    finish: (reply) => ({ channel: secureChannel(handshake.finish(reply).transport) }),
  };
};

/** Reads a phone's first message and classifies failures without exposing the failed Noise step. */
export const respondToHandshake = ({
  message,
  host,
  pairingPsk,
  randomBytes,
}: RespondToHandshakeInput): ResponderHandshake => {
  const pattern = message[0];
  if (
    (pattern !== CHANNEL_HANDSHAKE_CONNECT && pattern !== CHANNEL_HANDSHAKE_PAIR) ||
    message.length < 1 + IK_FIRST_MESSAGE_OVERHEAD ||
    message.length > 1 + NOISE_MAX_MESSAGE_BYTES
  ) {
    throw new ChannelHandshakeError("malformed");
  }
  const pairing = pattern === CHANNEL_HANDSHAKE_PAIR;
  const psk = pairing ? pairingPsk : undefined;
  if (psk === null) throw new ChannelHandshakeError("pairing-unavailable");

  try {
    const handshake = readIkInitiation(
      host,
      psk,
      message.subarray(1),
      randomBytes,
      channelPrologue(pattern),
    );
    return {
      remoteStaticKey: handshake.remoteStaticKey,
      payload: handshake.payload,
      pairing,
      accept: (payload) => {
        const { reply, transport } = handshake.accept(payload);
        return { reply, channel: secureChannel(transport) };
      },
    };
  } catch {
    throw new ChannelHandshakeError("authentication-failed");
  }
};
