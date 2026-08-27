// Session lifecycle: what is held, where, and that disconnect really clears it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { CONFIG_KEY, RESEARCH_ID_KEY, STORAGE_PREFIX, Session } from "../src/session.js";

/** A sessionStorage stand-in with the same surface. */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    _dump: () => Object.fromEntries(data),
  };
}

// See the note in github.test.mjs: not PAT-shaped, on purpose.
const TOKEN = "TEST-TOKEN-not-a-real-credential-4c81de";

// --- the token --------------------------------------------------------------

test("the token is never written to storage", () => {
  const storage = fakeStorage();
  const session = new Session(storage);
  session.setToken(TOKEN);
  session.startResearch("r-20260514-abcd1234", { fake: "key" });
  session.rememberConfig({ owner: "o", repo: "r" });

  assert.equal(JSON.stringify(storage._dump()).includes(TOKEN), false);
});

test("there is no getter that hands the token out", () => {
  const session = new Session(fakeStorage());
  session.setToken(TOKEN);
  assert.equal(session.token, undefined);
  assert.equal(JSON.stringify(session).includes(TOKEN), false);
  assert.equal(Object.values(session).includes(TOKEN), false);
});

test("the token reaches the GitHub client and nothing else", () => {
  const session = new Session(fakeStorage());
  session.setToken(TOKEN);
  let received = null;
  class Spy {
    constructor(config, token) {
      received = token;
    }
  }
  session.buildClient({ owner: "o" }, Spy);
  assert.equal(received, TOKEN);
});

test("connected reflects whether a token is held", () => {
  const session = new Session(fakeStorage());
  assert.equal(session.connected, false);
  session.setToken(TOKEN);
  assert.equal(session.connected, true);
  session.setToken("   ");
  assert.equal(session.connected, false);
});

// --- the key pair -----------------------------------------------------------

test("starting a research replaces the previous key pair", () => {
  const session = new Session(fakeStorage());
  const first = { id: "first" };
  const second = { id: "second" };
  session.startResearch("r-20260514-aaaaaaaa", first);
  assert.equal(session.privateKey, first);
  session.startResearch("r-20260514-bbbbbbbb", second);
  assert.equal(session.privateKey, second);
  assert.equal(session.researchId, "r-20260514-bbbbbbbb");
});

test("starting a research drops the previous result", () => {
  const session = new Session(fakeStorage());
  session.startResearch("r-1", { k: 1 });
  session.setResult({ hits: [1, 2, 3] });
  session.startResearch("r-2", { k: 2 });
  assert.equal(session.result, null);
});

test("the private key is not written to storage", () => {
  const storage = fakeStorage();
  const session = new Session(storage);
  session.startResearch("r-20260514-abcd1234", { secret: "private-key-material" });
  assert.equal(JSON.stringify(storage._dump()).includes("private-key-material"), false);
});

test("the research id is remembered, because it is not a secret", () => {
  const storage = fakeStorage();
  new Session(storage).startResearch("r-20260514-abcd1234", { k: 1 });
  assert.equal(storage.getItem(RESEARCH_ID_KEY), "r-20260514-abcd1234");
});

// --- disconnect -------------------------------------------------------------

test("disconnect clears every sensitive field", () => {
  const session = new Session(fakeStorage());
  session.setToken(TOKEN);
  session.startResearch("r-20260514-abcd1234", { k: 1 });
  session.setResult({ hits: [{ subject: "geheim" }] });
  session.repository = { fullName: "o/r" };

  session.disconnect();

  assert.equal(session.connected, false);
  assert.equal(session.privateKey, null);
  assert.equal(session.result, null);
  assert.equal(session.researchId, null);
  assert.equal(session.run, null);
  assert.equal(session.repository, null);
  assert.equal(session.status, "disconnected");
});

test("disconnect removes this application's storage keys", () => {
  const storage = fakeStorage();
  const session = new Session(storage);
  session.startResearch("r-20260514-abcd1234", { k: 1 });
  session.rememberConfig({ owner: "o" });
  assert.ok(storage.getItem(CONFIG_KEY));

  session.disconnect();
  assert.equal(storage.getItem(CONFIG_KEY), null);
  assert.equal(storage.getItem(RESEARCH_ID_KEY), null);
});

test("disconnect leaves another application's keys alone", () => {
  const storage = fakeStorage({ "other-app/setting": "keep me" });
  const session = new Session(storage);
  session.startResearch("r-1", { k: 1 });
  session.disconnect();
  assert.equal(storage.getItem("other-app/setting"), "keep me");
});

test("every key this application writes carries the shared prefix", () => {
  const storage = fakeStorage();
  const session = new Session(storage);
  session.startResearch("r-1", { k: 1 });
  session.rememberConfig({ owner: "o" });
  for (const key of Object.keys(storage._dump())) {
    assert.ok(key.startsWith(STORAGE_PREFIX), `${key} is not namespaced`);
  }
});

// --- configuration ----------------------------------------------------------

test("configuration survives a reload, and is not sensitive", () => {
  const storage = fakeStorage();
  new Session(storage).rememberConfig({ owner: "o", repo: "r" });
  assert.deepEqual(new Session(storage).recallConfig(), { owner: "o", repo: "r" });
});

test("a corrupt stored configuration is ignored, not thrown", () => {
  const storage = fakeStorage({ [CONFIG_KEY]: "{not json" });
  assert.equal(new Session(storage).recallConfig(), null);
});

test("storage that refuses to write does not break the session", () => {
  const refusing = {
    length: 0,
    key: () => null,
    getItem: () => {
      throw new Error("private mode");
    },
    setItem: () => {
      throw new Error("private mode");
    },
    removeItem: () => {},
  };
  const session = new Session(refusing);
  session.startResearch("r-1", { k: 1 });
  assert.equal(session.researchId, "r-1");
  assert.equal(session.recallConfig(), null);
});
