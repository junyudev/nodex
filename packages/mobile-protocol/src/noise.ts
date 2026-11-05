import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes, equalBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const NOISE_KEY_BYTES = 32;
export const NOISE_TAG_BYTES = 16;
export const NOISE_MAX_MESSAGE_BYTES = 65_535;

export const IK_FIRST_MESSAGE_OVERHEAD = 2 * (NOISE_KEY_BYTES + NOISE_TAG_BYTES);
const IK_REPLY_OVERHEAD = NOISE_KEY_BYTES + NOISE_TAG_BYTES;

const EMPTY = new Uint8Array(0);
const HASH_BYTES = sha256.outputLen;
const RESERVED_NONCE = (1n << 64n) - 1n;

export interface StaticKeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

type RandomBytes = (length: number) => Uint8Array;

const checkKeyLength = (key: Uint8Array): void => {
  if (key.length !== NOISE_KEY_BYTES) throw new Error("Invalid Noise key length");
};

export const generateStaticKeyPair = (randomBytes: RandomBytes): StaticKeyPair => {
  const secretKey = new Uint8Array(randomBytes(NOISE_KEY_BYTES));
  checkKeyLength(secretKey);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
};

const validateStaticKeyPair = ({ publicKey, secretKey }: StaticKeyPair): void => {
  if (!equalBytes(publicKey, x25519.getPublicKey(secretKey))) {
    throw new Error("Invalid Noise static key pair");
  }
};

const validateStaticPublicKey = (key: Uint8Array): void => {
  checkKeyLength(key);
  // Static keys are device identities. Require a unique encoding in [0, 2^255 - 19).
  const highByte = key[31] ?? 0;
  if (
    highByte >= 0x80 ||
    (highByte === 0x7f &&
      (key[0] ?? 0) >= 0xed &&
      key.subarray(1, 31).every((byte) => byte === 0xff))
  ) {
    throw new Error("Noncanonical Noise static key");
  }
};

// Noble rejects low-order inputs and an all-zero X25519 result.
const dh = x25519.getSharedSecret;

class CipherState {
  #nonce = 0n;
  readonly #key: Uint8Array;

  constructor(key: Uint8Array) {
    this.#key = key;
  }

  #cipher(ad: Uint8Array) {
    if (this.#nonce === RESERVED_NONCE) throw new Error("Noise nonce exhausted");
    const nonce = new Uint8Array(12);
    const view = new DataView(nonce.buffer);
    view.setUint32(4, Number(this.#nonce & 0xffffffffn), true);
    view.setUint32(8, Number(this.#nonce >> 32n), true);
    return chacha20poly1305(this.#key, nonce, ad);
  }

  seal(plaintext: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    const ciphertext = this.#cipher(ad).encrypt(plaintext);
    this.#nonce += 1n;
    return ciphertext;
  }

  open(ciphertext: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    const plaintext = this.#cipher(ad).decrypt(ciphertext);
    this.#nonce += 1n;
    return plaintext;
  }
}

export interface NoiseTransport {
  readonly send: CipherState;
  readonly receive: CipherState;
  readonly handshakeHash: Uint8Array;
}

/** Noise symmetric state using SHA-256 and ChaChaPoly. */
class SymmetricState {
  #chainingKey: Uint8Array;
  #hash: Uint8Array;
  #cipher: CipherState | undefined;

  constructor(protocolName: string) {
    const name = Uint8Array.from(protocolName, (char) => char.charCodeAt(0));
    this.#hash = name.length <= HASH_BYTES ? new Uint8Array(HASH_BYTES) : sha256(name);
    if (name.length <= HASH_BYTES) this.#hash.set(name);
    this.#chainingKey = this.#hash;
  }

  mixHash(data: Uint8Array): void {
    this.#hash = sha256.create().update(this.#hash).update(data).digest();
  }

  #deriveKeys(material: Uint8Array, blocks: 2 | 3): Uint8Array {
    return hkdf(sha256, material, this.#chainingKey, EMPTY, blocks * HASH_BYTES);
  }

  mixKey(material: Uint8Array): void {
    const output = this.#deriveKeys(material, 2);
    this.#chainingKey = output.subarray(0, HASH_BYTES);
    this.#cipher = new CipherState(output.subarray(HASH_BYTES));
  }

  mixKeyAndHash(material: Uint8Array): void {
    const output = this.#deriveKeys(material, 3);
    this.#chainingKey = output.subarray(0, HASH_BYTES);
    this.mixHash(output.subarray(HASH_BYTES, 2 * HASH_BYTES));
    this.#cipher = new CipherState(output.subarray(2 * HASH_BYTES));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.#cipher?.seal(plaintext, this.#hash) ?? plaintext;
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.#cipher?.open(ciphertext, this.#hash) ?? ciphertext;
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(initiator: boolean): NoiseTransport {
    const output = this.#deriveKeys(EMPTY, 2);
    const initiatorToResponder = new CipherState(output.subarray(0, HASH_BYTES));
    const responderToInitiator = new CipherState(output.subarray(HASH_BYTES));
    return {
      send: initiator ? initiatorToResponder : responderToInitiator,
      receive: initiator ? responderToInitiator : initiatorToResponder,
      handshakeHash: this.#hash,
    };
  }
}

const initializeIk = (
  hostKey: Uint8Array,
  pairing: boolean,
  prologue: Uint8Array,
): SymmetricState => {
  const pattern = pairing ? "IKpsk1" : "IK";
  const state = new SymmetricState(`Noise_${pattern}_25519_ChaChaPoly_SHA256`);
  state.mixHash(prologue);
  state.mixHash(hostKey); // <- s pre-message
  return state;
};

const mixEphemeral = (state: SymmetricState, publicKey: Uint8Array, pairing: boolean): void => {
  state.mixHash(publicKey);
  if (pairing) state.mixKey(publicKey);
};

const checkPayloadSize = (payload: Uint8Array, overhead: number): void => {
  if (payload.length > NOISE_MAX_MESSAGE_BYTES - overhead) {
    throw new Error("Noise handshake payload is too large");
  }
};

const once = <Input, Output>(run: (input: Input) => Output): ((input: Input) => Output) => {
  let pending: typeof run | undefined = run;
  return (input) => {
    const next = pending;
    if (!next) throw new Error("Noise handshake already consumed");
    pending = undefined;
    return next(input);
  };
};

/** Writes -> e, es, s, ss[, psk] and waits for <- e, ee, se. */
export const writeIkInitiation = (
  hostPublicKey: Uint8Array,
  device: StaticKeyPair,
  psk: Uint8Array | undefined,
  payload: Uint8Array,
  randomBytes: RandomBytes,
  prologue: Uint8Array = EMPTY,
) => {
  checkPayloadSize(payload, IK_FIRST_MESSAGE_OVERHEAD);
  validateStaticPublicKey(hostPublicKey);
  validateStaticKeyPair(device);
  if (psk) checkKeyLength(psk);

  const pairing = psk !== undefined;
  const state = initializeIk(hostPublicKey, pairing, prologue);
  const deviceSecret = new Uint8Array(device.secretKey);
  const ephemeral = generateStaticKeyPair(randomBytes);
  mixEphemeral(state, ephemeral.publicKey, pairing);
  state.mixKey(dh(ephemeral.secretKey, hostPublicKey));
  const encryptedStatic = state.encryptAndHash(device.publicKey);
  state.mixKey(dh(deviceSecret, hostPublicKey));
  if (psk) state.mixKeyAndHash(psk);

  return {
    message: concatBytes(ephemeral.publicKey, encryptedStatic, state.encryptAndHash(payload)),
    finish: once((reply: Uint8Array) => {
      if (reply.length < IK_REPLY_OVERHEAD || reply.length > NOISE_MAX_MESSAGE_BYTES) {
        throw new Error("Malformed Noise handshake reply");
      }
      const remoteEphemeral = reply.subarray(0, NOISE_KEY_BYTES);
      mixEphemeral(state, remoteEphemeral, pairing);
      state.mixKey(dh(ephemeral.secretKey, remoteEphemeral));
      state.mixKey(dh(deviceSecret, remoteEphemeral));
      const replyPayload = state.decryptAndHash(reply.subarray(NOISE_KEY_BYTES));
      return { payload: replyPayload, transport: state.split(true) };
    }),
  };
};

/** Reads -> e, es, s, ss[, psk] and prepares <- e, ee, se. */
export const readIkInitiation = (
  host: StaticKeyPair,
  psk: Uint8Array | undefined,
  message: Uint8Array,
  randomBytes: RandomBytes,
  prologue: Uint8Array = EMPTY,
) => {
  validateStaticKeyPair(host);
  if (psk) checkKeyLength(psk);

  const pairing = psk !== undefined;
  const state = initializeIk(host.publicKey, pairing, prologue);
  const remoteEphemeral = new Uint8Array(message.subarray(0, NOISE_KEY_BYTES));
  mixEphemeral(state, remoteEphemeral, pairing);
  state.mixKey(dh(host.secretKey, remoteEphemeral));
  const staticEnd = 2 * NOISE_KEY_BYTES + NOISE_TAG_BYTES;
  const remoteStatic = state.decryptAndHash(message.subarray(NOISE_KEY_BYTES, staticEnd));
  validateStaticPublicKey(remoteStatic);
  state.mixKey(dh(host.secretKey, remoteStatic));
  if (psk) state.mixKeyAndHash(psk);
  const payload = state.decryptAndHash(message.subarray(staticEnd));

  return {
    remoteStaticKey: remoteStatic.slice(),
    payload,
    accept: once((replyPayload: Uint8Array) => {
      checkPayloadSize(replyPayload, IK_REPLY_OVERHEAD);
      const ephemeral = generateStaticKeyPair(randomBytes);
      mixEphemeral(state, ephemeral.publicKey, pairing);
      state.mixKey(dh(ephemeral.secretKey, remoteEphemeral));
      state.mixKey(dh(ephemeral.secretKey, remoteStatic));
      const reply = concatBytes(ephemeral.publicKey, state.encryptAndHash(replyPayload));
      return { reply, transport: state.split(false) };
    }),
  };
};
