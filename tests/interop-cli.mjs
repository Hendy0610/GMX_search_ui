// A pipe between the two implementations, for the cross-language tests.
//
// Reads one JSON request on stdin, performs the operation with the browser
// code, writes one JSON response on stdout. Nothing here is used by the
// application; it exists so tests/test_crypto_interop.py and
// tests/test_query_preview_parity.py can drive the JavaScript side from Python
// and compare the two results directly, rather than comparing two descriptions
// of them.

import {
  decryptEnvelopeJson,
  encryptForRecipient,
  generateResearchKeyPair,
  toBase64,
} from "../src/crypto.js";
import { previewQuery } from "../src/query-preview.js";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Import a PKCS#8 private key so the browser side can act as a recipient. */
async function importPrivateKey(pkcs8B64) {
  const der = Buffer.from(pkcs8B64, "base64");
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

const OPERATIONS = {
  /** A fresh key pair, with the public half in the wire format. */
  async keypair() {
    const pair = await generateResearchKeyPair();
    return { publicKeyB64: pair.publicKeyB64 };
  },

  /** Encrypt with the browser implementation, for Python to decrypt. */
  async encrypt({ payload, recipientPublicKeyB64, context }) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    return { envelope: await encryptForRecipient(bytes, recipientPublicKeyB64, context) };
  },

  /** Decrypt a Python-produced envelope with the browser implementation. */
  async decrypt({ envelope, privateKeyB64, expectedResearchId }) {
    const privateKey = await importPrivateKey(privateKeyB64);
    const payload = await decryptEnvelopeJson(envelope, privateKey, {
      expectedResearchId: expectedResearchId ?? null,
    });
    return { payload };
  },

  /** The search terms the browser derives from a prompt. */
  async preview({ query, settings }) {
    const preview = previewQuery(query, settings ?? {});
    return {
      terms: preview.terms.map((term) => ({
        text: term.text,
        display: term.display,
        kind: term.kind,
        origin: term.origin,
        variants: term.variants,
        weight: term.weight,
        derived_from: term.derivedFrom,
      })),
      phrases: preview.phrases.map((term) => ({
        text: term.text,
        display: term.display,
        kind: term.kind,
        origin: term.origin,
        variants: term.variants,
        weight: term.weight,
        derived_from: term.derivedFrom,
      })),
      stopwords_removed: preview.stopwordsRemoved,
    };
  },

  /** Base64 of arbitrary bytes, to check the two agree on encoding. */
  async b64({ bytes }) {
    return { value: toBase64(Uint8Array.from(bytes)) };
  },
};

const request = JSON.parse(await readStdin());
try {
  const handler = OPERATIONS[request.op];
  if (!handler) {
    throw new Error(`unknown operation: ${request.op}`);
  }
  process.stdout.write(JSON.stringify({ ok: true, ...(await handler(request)) }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({ ok: false, error: String(error?.message ?? error), name: error?.name }),
  );
}
