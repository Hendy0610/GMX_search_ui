// The browser's half of the encryption, tested against itself.
//
// Agreement with the Python side is a separate, stronger test
// (tests/test_crypto_interop.py). What is checked here is the behaviour this
// implementation owns: that it refuses a malformed envelope before touching key
// material, that it notices tampering, and that a private key really cannot be
// exported.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALGORITHM,
  CryptoError,
  ENVELOPE_SCHEMA,
  decryptEnvelope,
  decryptEnvelopeJson,
  encryptForRecipient,
  fromBase64,
  generateResearchKeyPair,
  toBase64,
  validateEnvelope,
} from "../src/crypto.js";

const RESEARCH_ID = "r-20260514-abcd1234";

/** Envelope in the shape the results branch carries. */
function asStoredEnvelope(cryptoEnvelope, researchId = RESEARCH_ID) {
  return {
    schema_version: ENVELOPE_SCHEMA,
    research_id: researchId,
    kind: "result",
    created_at: "2026-05-14T09:30:00+00:00",
    algorithm: cryptoEnvelope.alg,
    kdf: "HKDF-SHA256",
    runner_public_key: cryptoEnvelope.epk,
    kdf_salt: cryptoEnvelope.salt,
    nonce: cryptoEnvelope.iv,
    aad: cryptoEnvelope.context,
    ciphertext: cryptoEnvelope.ct,
  };
}

async function sealed(payload, researchId = RESEARCH_ID) {
  const pair = await generateResearchKeyPair();
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const envelope = await encryptForRecipient(bytes, pair.publicKeyB64, researchId);
  return { pair, stored: asStoredEnvelope(envelope, researchId) };
}

// --- the happy path ---------------------------------------------------------

test("an envelope round-trips", async () => {
  const { pair, stored } = await sealed({ hello: "world" });
  const result = await decryptEnvelopeJson(stored, pair.privateKey, {
    expectedResearchId: RESEARCH_ID,
  });
  assert.deepEqual(result, { hello: "world" });
});

test("umlauts and other Unicode survive", async () => {
  const payload = { subject: "Verzögerung – Nachträge, 25 °C, 😀, Ärger" };
  const { pair, stored } = await sealed(payload);
  assert.deepEqual(
    await decryptEnvelopeJson(stored, pair.privateKey, { expectedResearchId: RESEARCH_ID }),
    payload,
  );
});

test("a realistically large payload survives", async () => {
  const hits = Array.from({ length: 200 }, (_, index) => ({
    subject: `Nachricht ${index} über Fristüberschreitungen`,
    snippet: "x".repeat(320),
  }));
  const { pair, stored } = await sealed({ hits });
  const decoded = await decryptEnvelopeJson(stored, pair.privateKey, {
    expectedResearchId: RESEARCH_ID,
  });
  assert.equal(decoded.hits.length, 200);
});

// --- the key pair -----------------------------------------------------------

test("the private key cannot be exported", async () => {
  const pair = await generateResearchKeyPair();
  await assert.rejects(() => globalThis.crypto.subtle.exportKey("pkcs8", pair.privateKey));
  await assert.rejects(() => globalThis.crypto.subtle.exportKey("jwk", pair.privateKey));
});

test("the public key is a raw uncompressed P-256 point", async () => {
  const pair = await generateResearchKeyPair();
  const raw = fromBase64(pair.publicKeyB64, "public key");
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 0x04);
});

test("every call produces a different key pair", async () => {
  const first = await generateResearchKeyPair();
  const second = await generateResearchKeyPair();
  assert.notEqual(first.publicKeyB64, second.publicKeyB64);
});

// --- refusals ---------------------------------------------------------------

test("a wrong research id is refused before any key is touched", async () => {
  const { pair, stored } = await sealed({ a: 1 });
  await assert.rejects(
    () => decryptEnvelope(stored, pair.privateKey, { expectedResearchId: "r-20260101-zzzzzzzz" }),
    (error) => error instanceof CryptoError && /different research run/.test(error.message),
  );
});

test("an envelope whose aad disagrees with its id is refused", async () => {
  const { pair, stored } = await sealed({ a: 1 });
  stored.aad = "r-20260101-zzzzzzzz";
  await assert.rejects(
    () => decryptEnvelope(stored, pair.privateKey, { expectedResearchId: RESEARCH_ID }),
    (error) => error instanceof CryptoError && /authenticated data/.test(error.message),
  );
});

test("a tampered ciphertext fails authentication", async () => {
  const { pair, stored } = await sealed({ a: 1 });
  const bytes = fromBase64(stored.ciphertext, "ct");
  bytes[5] ^= 0xff;
  stored.ciphertext = toBase64(bytes);
  await assert.rejects(
    () => decryptEnvelope(stored, pair.privateKey, { expectedResearchId: RESEARCH_ID }),
    (error) => error instanceof CryptoError && /authentication/.test(error.message),
  );
});

test("a tampered salt fails authentication", async () => {
  const { pair, stored } = await sealed({ a: 1 });
  const bytes = fromBase64(stored.kdf_salt, "salt");
  bytes[0] ^= 0xff;
  stored.kdf_salt = toBase64(bytes);
  await assert.rejects(() =>
    decryptEnvelope(stored, pair.privateKey, { expectedResearchId: RESEARCH_ID }),
  );
});

test("another session's key does not open the envelope", async () => {
  const { stored } = await sealed({ a: 1 });
  const stranger = await generateResearchKeyPair();
  await assert.rejects(() =>
    decryptEnvelope(stored, stranger.privateKey, { expectedResearchId: RESEARCH_ID }),
  );
});

test("a swapped runner public key fails", async () => {
  const { pair, stored } = await sealed({ a: 1 });
  const other = await generateResearchKeyPair();
  stored.runner_public_key = other.publicKeyB64;
  await assert.rejects(() =>
    decryptEnvelope(stored, pair.privateKey, { expectedResearchId: RESEARCH_ID }),
  );
});

// --- envelope validation ----------------------------------------------------

test("an unknown schema is refused", () => {
  assert.throws(
    () => validateEnvelope({ schema_version: "something/9" }, RESEARCH_ID),
    /unsupported envelope schema/,
  );
});

test("an unknown algorithm is refused", () => {
  assert.throws(
    () => validateEnvelope({ schema_version: ENVELOPE_SCHEMA, algorithm: "ROT13" }, RESEARCH_ID),
    /unsupported algorithm/,
  );
});

test("a missing field is named", () => {
  const base = {
    schema_version: ENVELOPE_SCHEMA,
    algorithm: ALGORITHM,
    kdf: "HKDF-SHA256",
    research_id: RESEARCH_ID,
    aad: RESEARCH_ID,
    runner_public_key: "x",
    kdf_salt: "x",
    nonce: "x",
    ciphertext: "x",
  };
  for (const field of ["runner_public_key", "kdf_salt", "nonce", "ciphertext"]) {
    const broken = { ...base, [field]: "" };
    assert.throws(() => validateEnvelope(broken, RESEARCH_ID), new RegExp(field));
  }
});

test("a nonce of the wrong length is refused", async () => {
  const { stored } = await sealed({ a: 1 });
  stored.nonce = toBase64(new Uint8Array(16));
  assert.throws(() => validateEnvelope(stored, RESEARCH_ID), /nonce must be 12 bytes/);
});

test("a malformed public key is refused with a clear message", async () => {
  const { pair, stored } = await sealed({ a: 1 });
  stored.runner_public_key = toBase64(new Uint8Array(64));
  await assert.rejects(
    () => decryptEnvelope(stored, pair.privateKey, { expectedResearchId: RESEARCH_ID }),
    /65 bytes/,
  );
});

test("non-base64 input is reported as such", () => {
  assert.throws(() => fromBase64("not base64 !!!", "field"), /not valid base64/);
  assert.throws(() => fromBase64("", "field"), /missing/);
});

test("a payload that is not JSON is reported, not returned", async () => {
  const pair = await generateResearchKeyPair();
  const envelope = await encryptForRecipient(
    new TextEncoder().encode("this is not json"),
    pair.publicKeyB64,
    RESEARCH_ID,
  );
  await assert.rejects(
    () =>
      decryptEnvelopeJson(asStoredEnvelope(envelope), pair.privateKey, {
        expectedResearchId: RESEARCH_ID,
      }),
    /not valid JSON/,
  );
});

test("encryption refuses an empty context", async () => {
  const pair = await generateResearchKeyPair();
  await assert.rejects(
    () => encryptForRecipient(new Uint8Array([1]), pair.publicKeyB64, ""),
    /context must not be empty/,
  );
});
