// The browser half of the end-to-end encryption.
//
// The runner can only encrypt. It receives a public key as a workflow input,
// encrypts the result to it, and forgets everything. The matching private key
// is generated here and never leaves this page - it is created
// **non-extractable**, so there is no code path, ours or anyone's, that can
// serialise it. Lose the tab and the result becomes unreadable; that is the
// price of the guarantee, and it is deliberate.
//
// Scheme, identical to app/services/crypto_box.py:
//
//     ECDH(P-256) -> HKDF-SHA256 -> AES-256-GCM
//
//     public keys   raw uncompressed point (0x04 || X || Y), base64
//     HKDF salt     32 random bytes, carried in the envelope
//     HKDF info     "gmx-research/v1/" + research_id, UTF-8
//     HKDF length   32 bytes
//     AES nonce     12 bytes, carried in the envelope
//     AES AAD       research_id, UTF-8
//     ciphertext    AES-GCM output with the 16-byte tag appended, base64
//
// tests/test_crypto_interop.py encrypts in one language and decrypts in the
// other, in both directions, so this comment cannot quietly become wrong.

export const ENVELOPE_VERSION = 1;
export const ALGORITHM = "ECDH-P256+HKDF-SHA256+AES-256-GCM";
export const ENVELOPE_SCHEMA = "gmx-research-envelope/1";
const HKDF_INFO_PREFIX = "gmx-research/v1/";
const RAW_PUBLIC_KEY_BYTES = 65;
const NONCE_BYTES = 12;
const KEY_BITS = 256;
const TAG_BITS = 128;

export class CryptoError extends Error {
  constructor(message) {
    super(message);
    this.name = "CryptoError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function toBase64(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function fromBase64(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CryptoError(`${field} is missing`);
  }
  let binary;
  try {
    binary = atob(value.trim());
  } catch {
    throw new CryptoError(`${field} is not valid base64`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Generate the key pair for exactly one research run.
 *
 * The private key is non-extractable: `crypto.subtle.exportKey` on it throws,
 * which is what makes "the private key never leaves the browser" a property of
 * the platform rather than a promise in a comment.
 *
 * @param {Crypto} [subtleSource] injected in tests
 * @returns {Promise<{privateKey: CryptoKey, publicKeyB64: string}>}
 */
export async function generateResearchKeyPair(subtleSource = globalThis.crypto) {
  const pair = await subtleSource.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false, // private key not extractable
    ["deriveBits"],
  );
  const raw = await subtleSource.subtle.exportKey("raw", pair.publicKey);
  return { privateKey: pair.privateKey, publicKeyB64: toBase64(raw) };
}

function checkRawPublicKey(bytes) {
  if (bytes.length !== RAW_PUBLIC_KEY_BYTES) {
    throw new CryptoError(
      `public key must be ${RAW_PUBLIC_KEY_BYTES} bytes (uncompressed P-256 point), got ${bytes.length}`,
    );
  }
  if (bytes[0] !== 0x04) {
    throw new CryptoError("public key must be an uncompressed point (0x04 prefix)");
  }
  return bytes;
}

async function importPeerPublicKey(publicKeyB64, subtleSource) {
  const raw = checkRawPublicKey(fromBase64(publicKeyB64, "runner public key"));
  try {
    return await subtleSource.subtle.importKey(
      "raw",
      raw,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch {
    throw new CryptoError("runner public key is not a valid P-256 point");
  }
}

async function deriveAesKey(privateKey, peerKey, salt, context, subtleSource, usages) {
  const shared = await subtleSource.subtle.deriveBits(
    { name: "ECDH", public: peerKey },
    privateKey,
    KEY_BITS,
  );
  const hkdfKey = await subtleSource.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveBits",
  ]);
  const keyBytes = await subtleSource.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: encoder.encode(HKDF_INFO_PREFIX + context),
    },
    hkdfKey,
    KEY_BITS,
  );
  return subtleSource.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, usages);
}

/**
 * Validate an envelope's shape before any key material is touched.
 *
 * Separate from decryption on purpose: a malformed envelope should be reported
 * as malformed, not as a failed decryption, and the checks are the ones the
 * Python side makes.
 */
export function validateEnvelope(envelope, expectedResearchId) {
  if (!envelope || typeof envelope !== "object") {
    throw new CryptoError("envelope is not an object");
  }
  if (envelope.schema_version !== ENVELOPE_SCHEMA) {
    throw new CryptoError(`unsupported envelope schema: ${String(envelope.schema_version)}`);
  }
  if (envelope.algorithm !== ALGORITHM) {
    throw new CryptoError(`unsupported algorithm: ${String(envelope.algorithm)}`);
  }
  if (envelope.kdf !== "HKDF-SHA256") {
    throw new CryptoError(`unsupported key derivation: ${String(envelope.kdf)}`);
  }
  if (typeof envelope.research_id !== "string" || !envelope.research_id) {
    throw new CryptoError("envelope has no research id");
  }
  if (expectedResearchId && envelope.research_id !== expectedResearchId) {
    throw new CryptoError("envelope belongs to a different research run");
  }
  // The AAD binds the ciphertext to the id. If the two disagree the envelope
  // has been rewritten, and decryption would fail anyway - failing here says
  // why.
  if (envelope.aad !== envelope.research_id) {
    throw new CryptoError("envelope id and authenticated data disagree");
  }
  for (const field of ["runner_public_key", "kdf_salt", "nonce", "ciphertext"]) {
    if (typeof envelope[field] !== "string" || !envelope[field]) {
      throw new CryptoError(`envelope is missing ${field}`);
    }
  }
  const nonce = fromBase64(envelope.nonce, "nonce");
  if (nonce.length !== NONCE_BYTES) {
    throw new CryptoError(`nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`);
  }
  return envelope;
}

/**
 * Decrypt one envelope. Returns the plaintext bytes.
 *
 * Every failure - a wrong key, a tampered ciphertext, a swapped id - surfaces
 * as a CryptoError. There is no partial result: AES-GCM either authenticates
 * the whole message or produces nothing.
 */
export async function decryptEnvelope(
  envelope,
  privateKey,
  { expectedResearchId = null, subtleSource = globalThis.crypto } = {},
) {
  validateEnvelope(envelope, expectedResearchId);
  const context = envelope.research_id;
  const peerKey = await importPeerPublicKey(envelope.runner_public_key, subtleSource);
  const key = await deriveAesKey(
    privateKey,
    peerKey,
    fromBase64(envelope.kdf_salt, "kdf_salt"),
    context,
    subtleSource,
    ["decrypt"],
  );
  try {
    const plaintext = await subtleSource.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(envelope.nonce, "nonce"),
        additionalData: encoder.encode(context),
        tagLength: TAG_BITS,
      },
      key,
      fromBase64(envelope.ciphertext, "ciphertext"),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new CryptoError("envelope failed authentication (wrong key or tampered data)");
  }
}

/** Decrypt and parse the JSON result payload. */
export async function decryptEnvelopeJson(envelope, privateKey, options = {}) {
  const bytes = await decryptEnvelope(envelope, privateKey, options);
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new CryptoError("decrypted payload is not valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CryptoError("decrypted payload is not valid JSON");
  }
}

/**
 * Encrypt to a recipient public key.
 *
 * The application never calls this - the runner does the encrypting. It exists
 * so the interoperability test can drive the browser implementation in the
 * other direction and prove both sides agree.
 */
export async function encryptForRecipient(
  plaintext,
  recipientPublicKeyB64,
  context,
  subtleSource = globalThis.crypto,
) {
  if (!context) {
    throw new CryptoError("context must not be empty");
  }
  const recipientKey = await importPeerPublicKey(recipientPublicKeyB64, subtleSource);
  const ephemeral = await subtleSource.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const salt = subtleSource.getRandomValues(new Uint8Array(32));
  const nonce = subtleSource.getRandomValues(new Uint8Array(NONCE_BYTES));
  const key = await deriveAesKey(
    ephemeral.privateKey,
    recipientKey,
    salt,
    context,
    subtleSource,
    ["encrypt"],
  );
  const ciphertext = await subtleSource.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: encoder.encode(context),
      tagLength: TAG_BITS,
    },
    key,
    plaintext,
  );
  const epk = await subtleSource.subtle.exportKey("raw", ephemeral.publicKey);
  return {
    v: ENVELOPE_VERSION,
    alg: ALGORITHM,
    context,
    epk: toBase64(epk),
    salt: toBase64(salt),
    iv: toBase64(nonce),
    ct: toBase64(ciphertext),
  };
}
