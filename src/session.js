// Everything sensitive this page holds, and how it stops holding it.
//
// The design rule is that nothing sensitive survives the tab. Concretely:
//
//   token           in memory only - never sessionStorage, never localStorage,
//                   never a cookie. Reload asks again; that is the point.
//   private key     a non-extractable CryptoKey, so it cannot be serialised
//                   even by mistake. One per research run, never reused.
//   research id     sessionStorage, so a reload can pick a run back up. It is a
//                   random correlation id, not a secret.
//   results         in memory only, decrypted, dropped on disconnect.
//
// The repository configuration is not sensitive and is remembered in
// sessionStorage so the operator does not retype it each time.

const STORAGE_PREFIX = "gmx-research/";
const RESEARCH_ID_KEY = `${STORAGE_PREFIX}research-id`;
const CONFIG_KEY = `${STORAGE_PREFIX}config`;

/**
 * Session state.
 *
 * Fields holding a secret are private class fields: they are unreachable from
 * outside, so no rendering code can put one on the page by accident.
 */
export class Session {
  #token = "";
  #privateKey = null;
  #result = null;

  constructor(storage = globalThis.sessionStorage) {
    this.storage = storage;
    this.researchId = null;
    this.run = null;
    this.status = "disconnected";
    this.repository = null;
  }

  // -- the token ---------------------------------------------------------

  get connected() {
    return Boolean(this.#token);
  }

  setToken(token) {
    this.#token = typeof token === "string" ? token.trim() : "";
  }

  /**
   * Hand the token to the GitHub client and nowhere else.
   *
   * A getter would make it trivially available to any caller, including
   * rendering code. A factory keeps the only legitimate consumer explicit.
   */
  buildClient(config, ClientClass, fetchImpl) {
    return new ClientClass(config, this.#token, fetchImpl);
  }

  // -- the research key pair --------------------------------------------

  /**
   * Adopt the key pair for a new run, discarding any previous one.
   *
   * Discarding matters: reusing a key pair across runs would mean one leaked
   * key exposes every result, and the whole reason the key is ephemeral is that
   * it should expose at most one.
   */
  startResearch(researchId, privateKey) {
    this.#privateKey = privateKey;
    this.#result = null;
    this.researchId = researchId;
    this.run = null;
    this.status = "starting";
    this.#write(RESEARCH_ID_KEY, researchId);
  }

  get privateKey() {
    return this.#privateKey;
  }

  get hasResearch() {
    return Boolean(this.researchId && this.#privateKey);
  }

  // -- the decrypted result ---------------------------------------------

  setResult(result) {
    this.#result = result;
  }

  get result() {
    return this.#result;
  }

  // -- configuration (not sensitive) ------------------------------------

  rememberConfig(config) {
    this.#write(CONFIG_KEY, JSON.stringify(config));
  }

  recallConfig() {
    const raw = this.#read(CONFIG_KEY);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // -- teardown ----------------------------------------------------------

  /**
   * Forget everything. Called by "Verbindung trennen" and before a new run.
   *
   * Clears the token, the private key, the decrypted result, the research id
   * and every key this application wrote - and nothing else in sessionStorage,
   * which may belong to another page on the same origin.
   */
  disconnect() {
    this.#token = "";
    this.#privateKey = null;
    this.#result = null;
    this.researchId = null;
    this.run = null;
    this.repository = null;
    this.status = "disconnected";
    this.#clearOwnStorage();
  }

  #clearOwnStorage() {
    if (!this.storage) {
      return;
    }
    const keys = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (typeof key === "string" && key.startsWith(STORAGE_PREFIX)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      this.storage.removeItem(key);
    }
  }

  #write(key, value) {
    try {
      this.storage?.setItem(key, value);
    } catch {
      // A private window can refuse storage. The application works without it;
      // only the convenience of surviving a reload is lost.
    }
  }

  #read(key) {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
}

export { CONFIG_KEY, RESEARCH_ID_KEY, STORAGE_PREFIX };
