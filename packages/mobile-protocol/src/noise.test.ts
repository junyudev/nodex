import { hexToBytes } from "@noble/hashes/utils.js";
import { assert, expect, test } from "vite-plus/test";

import { generateStaticKeyPair, readIkInitiation, writeIkInitiation } from "./noise";
import fixture from "./noise-vectors.json" with { type: "json" };

test.each(fixture.vectors)("matches the published $protocol_name vector", (vector) => {
  const [first, second, ...transport] = vector.messages;
  assert(first && second);
  const initiatorPsk = vector.init_psks?.[0];
  const responderPsk = vector.resp_psks?.[0];
  const host = generateStaticKeyPair(() => hexToBytes(vector.resp_static));
  const device = generateStaticKeyPair(() => hexToBytes(vector.init_static));
  const initiated = writeIkInitiation(
    hexToBytes(vector.init_remote_static),
    device,
    initiatorPsk === undefined ? undefined : hexToBytes(initiatorPsk),
    hexToBytes(first.payload),
    () => hexToBytes(vector.init_ephemeral),
    hexToBytes(vector.init_prologue),
  );
  expect(initiated.message).toEqual(hexToBytes(first.ciphertext));

  const response = readIkInitiation(
    host,
    responderPsk === undefined ? undefined : hexToBytes(responderPsk),
    hexToBytes(first.ciphertext),
    () => hexToBytes(vector.resp_ephemeral),
    hexToBytes(vector.resp_prologue),
  );
  expect(response.remoteStaticKey).toEqual(device.publicKey);
  expect(response.payload).toEqual(hexToBytes(first.payload));

  const responder = response.accept(hexToBytes(second.payload));
  expect(responder.reply).toEqual(hexToBytes(second.ciphertext));
  const initiator = initiated.finish(hexToBytes(second.ciphertext));
  expect(initiator.payload).toEqual(hexToBytes(second.payload));
  expect(initiator.transport.handshakeHash).toEqual(hexToBytes(vector.handshake_hash));
  expect(responder.transport.handshakeHash).toEqual(hexToBytes(vector.handshake_hash));

  for (const [index, message] of transport.entries()) {
    const [sender, receiver] = index % 2 === 0 ? [initiator, responder] : [responder, initiator];
    expect(sender.transport.send.seal(hexToBytes(message.payload))).toEqual(
      hexToBytes(message.ciphertext),
    );
    expect(receiver.transport.receive.open(hexToBytes(message.ciphertext))).toEqual(
      hexToBytes(message.payload),
    );
  }
});
