// Wiring. Everything decided elsewhere; this file only sequences it.
//
// The flow the operator sees, and the order the code follows:
//
//     verbinden -> Auftrag eingeben -> Suchumfang prüfen -> starten
//                                  -> warten -> Ergebnisse
//
// Two rules hold throughout:
//
// * A new run always means a new key pair and a new research id. Reuse is not
//   an optimisation here, it is a way for one leaked key to expose two results.
// * Nothing from a result reaches the page before it has been decrypted and
//   validated. There is no "show what we have so far".

import { CONFIG } from "../config.js";
import { CryptoError, decryptEnvelopeJson, generateResearchKeyPair } from "./crypto.js";
import { GitHubClient, GitHubError } from "./github.js";
import { previewQuery } from "./query-preview.js";
import { renderQueryPreview, renderResults } from "./render.js";
import { Session } from "./session.js";

const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const RESEARCH_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A research id: sortable by day, unguessable within it.
 *
 * The random half matters. Research ids become file names on a branch that
 * anyone with repository read access can list, and a predictable name would let
 * them watch for a specific run's envelope.
 */
export function newResearchId(now = new Date(), randomSource = globalThis.crypto) {
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("");
  const bytes = randomSource.getRandomValues(new Uint8Array(8));
  const suffix = [...bytes]
    .map((byte) => RESEARCH_ID_ALPHABET[byte % RESEARCH_ID_ALPHABET.length])
    .join("");
  return `r-${stamp}-${suffix}`;
}

/**
 * Build the dispatch payload from the form.
 *
 * Only filters the backend actually understands: offering one it ignores would
 * be a lie told by the interface. Empty values are omitted rather than sent as
 * null, matching what encode_research_inputs produces.
 */
export function buildPayload({ query, dateFrom, dateTo, senders, folders }) {
  const filters = {
    date_from: dateFrom || null,
    date_to: dateTo || null,
    senders: splitList(senders).map((value) => value.toLowerCase()),
    folders: splitList(folders),
  };
  return { schema: "gmx-research-request/1", query, filters };
}

export function splitList(value) {
  return String(value ?? "")
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Validation that mirrors the backend's, so a bad request never costs a run. */
export function validateForm({ query, dateFrom, dateTo, senders }) {
  const problems = [];
  if (!query || !query.trim()) {
    problems.push("Bitte beschreiben Sie, wonach gesucht werden soll.");
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    problems.push("Das Startdatum liegt nach dem Enddatum.");
  }
  for (const sender of splitList(senders)) {
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(sender)) {
      problems.push(`Keine verwendbare Absenderadresse: ${sender}`);
    }
  }
  return problems;
}

/** Workflow status and conclusion, as one word the operator can act on. */
export function describeRunState(run) {
  if (!run) {
    return { state: "starting", text: "Wird gestartet …" };
  }
  if (run.status === "queued" || run.status === "pending") {
    return { state: "queued", text: "In Warteschlange" };
  }
  if (run.status === "in_progress") {
    return { state: "running", text: "Recherche läuft …" };
  }
  if (run.status !== "completed") {
    return { state: "running", text: "Recherche läuft …" };
  }
  switch (run.conclusion) {
    case "success":
      return { state: "success", text: "Erfolgreich abgeschlossen" };
    case "cancelled":
      return { state: "failed", text: "Abgebrochen" };
    case "timed_out":
      return { state: "failed", text: "Zeitüberschreitung" };
    default:
      return { state: "failed", text: "Fehlgeschlagen" };
  }
}

// -- the application -------------------------------------------------------

export class App {
  constructor(doc, { config = CONFIG, fetchImpl, cryptoImpl, storage } = {}) {
    this.doc = doc;
    this.config = { ...config };
    this.fetchImpl = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.crypto = cryptoImpl ?? globalThis.crypto;
    this.session = new Session(storage ?? globalThis.sessionStorage);
    this.client = null;
    this.pollTimer = null;
  }

  $(id) {
    return this.doc.getElementById(id);
  }

  start() {
    const remembered = this.session.recallConfig();
    if (remembered) {
      this.config = { ...this.config, ...remembered };
    }
    this.#fillConfigFields();
    this.$("connect-form").addEventListener("submit", (event) => {
      event.preventDefault();
      this.connect();
    });
    this.$("disconnect").addEventListener("click", () => this.disconnect());
    this.$("research-form").addEventListener("submit", (event) => {
      event.preventDefault();
      this.startResearch();
    });
    this.$("query").addEventListener("input", () => this.updatePreview());
    this.$("new-research").addEventListener("click", () => this.resetForNewResearch());
    this.updatePreview();
    this.#guardAgainstLosingTheKey();
    this.#setStep("connect");
  }

  /**
   * Warn before the tab closes while a run is in flight.
   *
   * The private key exists only here and is non-extractable. Close the tab
   * mid-run and the result becomes permanently unreadable - the runner can only
   * encrypt. That is the deliberate trade, but the operator should not discover
   * it by accident.
   */
  #guardAgainstLosingTheKey() {
    globalThis.addEventListener?.("beforeunload", (event) => {
      if (this.pollTimer === null) {
        return;
      }
      event.preventDefault();
      // Browsers show their own wording; the value only has to be set.
      event.returnValue = "";
    });
  }

  #fillConfigFields() {
    this.$("owner").value = this.config.owner ?? "";
    this.$("repo").value = this.config.repo ?? "";
    this.$("results-branch").value = this.config.resultsBranch ?? "";
  }

  #readConfigFields() {
    return {
      ...this.config,
      owner: this.$("owner").value.trim(),
      repo: this.$("repo").value.trim(),
      resultsBranch: this.$("results-branch").value.trim(),
    };
  }

  #setStep(step) {
    this.doc.body.setAttribute("data-step", step);
  }

  #status(id, message, tone = "info") {
    const node = this.$(id);
    node.textContent = message;
    node.className = `status status-${tone}`;
  }

  // -- connecting --------------------------------------------------------

  async connect() {
    const token = this.$("token").value;
    if (!token.trim()) {
      this.#status("connect-status", "Bitte geben Sie einen Zugriffstoken ein.", "error");
      return;
    }
    this.config = this.#readConfigFields();
    this.session.setToken(token);
    // The field is cleared immediately: a token sitting in a DOM value is one
    // screenshot, one autofill, one extension away from leaving the page.
    this.$("token").value = "";

    this.client = this.session.buildClient(this.config, GitHubClient, this.fetchImpl);
    this.#status("connect-status", "Verbindung wird geprüft …");
    try {
      const repository = await this.client.validateRepository();
      this.session.repository = repository;
      this.session.rememberConfig({
        owner: this.config.owner,
        repo: this.config.repo,
        resultsBranch: this.config.resultsBranch,
      });
      this.#status(
        "connect-status",
        `Verbunden mit ${repository.fullName}${repository.private ? " (privat)" : ""}.`,
        "ok",
      );
      this.#setStep("research");
    } catch (error) {
      this.session.disconnect();
      this.client = null;
      this.#status("connect-status", messageFor(error), "error");
    }
  }

  disconnect() {
    this.#stopPolling();
    this.client?.disconnect();
    this.client = null;
    this.session.disconnect();
    this.$("token").value = "";
    this.$("results").replaceChildren();
    this.#status("connect-status", "Verbindung getrennt. Alle Sitzungsdaten wurden gelöscht.");
    this.#status("run-status", "");
    this.#setStep("connect");
  }

  // -- the search-scope preview -----------------------------------------

  updatePreview() {
    const preview = previewQuery(this.$("query").value);
    const container = this.$("preview");
    container.replaceChildren();
    if (!preview.hasTerms) {
      container.appendChild(
        this.doc.createTextNode(
          "Noch keine verwendbaren Suchbegriffe. Beschreiben Sie, worum es geht.",
        ),
      );
      return;
    }
    container.appendChild(renderQueryPreview(this.doc, preview));
  }

  // -- starting a run ----------------------------------------------------

  async startResearch() {
    const form = {
      query: this.$("query").value,
      dateFrom: this.$("date-from").value,
      dateTo: this.$("date-to").value,
      senders: this.$("senders").value,
      folders: this.$("folders").value,
    };
    const problems = validateForm(form);
    if (problems.length) {
      this.#status("run-status", problems.join(" "), "error");
      return;
    }
    if (!this.client) {
      this.#status("run-status", "Bitte zuerst mit GitHub verbinden.", "error");
      return;
    }

    // One run, one key pair, one id - always freshly generated.
    const researchId = newResearchId(new Date(), this.crypto);
    let keyPair;
    try {
      keyPair = await generateResearchKeyPair(this.crypto);
    } catch {
      this.#status(
        "run-status",
        "Dieser Browser stellt die benötigte Verschlüsselung nicht bereit.",
        "error",
      );
      return;
    }
    this.session.startResearch(researchId, keyPair.privateKey);

    this.#setStep("running");
    this.#status("run-status", "Recherche wird gestartet …");
    try {
      await this.client.dispatchResearch({
        researchId,
        publicKeyB64: keyPair.publicKeyB64,
        payload: buildPayload(form),
        ref: this.config.ref,
      });
    } catch (error) {
      this.#status("run-status", messageFor(error), "error");
      this.#setStep("research");
      return;
    }
    this.#pollUntilDone(researchId);
  }

  // -- following the run -------------------------------------------------

  #stopPolling() {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Poll until the run finishes, then fetch the result.
   *
   * Four seconds: often enough to feel live, rare enough that a half-hour run
   * costs a few hundred requests rather than a few thousand. Polling stops the
   * moment the run is no longer in progress - and on a deadline, so a run that
   * never reports back cannot leave the page polling forever.
   */
  #pollUntilDone(researchId, deadline = Date.now() + POLL_TIMEOUT_MS) {
    this.#stopPolling();
    const tick = async () => {
      if (Date.now() > deadline) {
        this.#status(
          "run-status",
          "Die Recherche meldet seit längerer Zeit keinen Fortschritt. Bitte prüfen Sie den Lauf in GitHub.",
          "error",
        );
        return;
      }
      try {
        const run = this.session.run
          ? await this.client.getWorkflowRun(this.session.run.id)
          : await this.client.findRun(researchId);
        if (run) {
          this.session.run = run;
        }
        const state = describeRunState(run);
        this.#status("run-status", state.text, state.state === "failed" ? "error" : "info");

        if (state.state === "success") {
          await this.#collectResult(researchId);
          return;
        }
        if (state.state === "failed") {
          this.#status(
            "run-status",
            `${state.text}. Die Recherche wurde nicht abgeschlossen; es liegt kein Ergebnis vor.`,
            "error",
          );
          return;
        }
      } catch (error) {
        this.#status("run-status", messageFor(error), "error");
        return;
      }
      this.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    this.pollTimer = setTimeout(tick, 1200);
  }

  // -- the result --------------------------------------------------------

  async #collectResult(researchId) {
    this.#status("run-status", "Ergebnis wird abgerufen und entschlüsselt …");
    let envelope;
    try {
      envelope = await this.client.getResultEnvelope(researchId);
    } catch (error) {
      this.#status("run-status", messageFor(error), "error");
      return;
    }
    if (!envelope) {
      // The run can finish a moment before its commit is visible.
      this.pollTimer = setTimeout(() => this.#collectResult(researchId), POLL_INTERVAL_MS);
      return;
    }

    let result;
    try {
      result = await decryptEnvelopeJson(envelope, this.session.privateKey, {
        expectedResearchId: researchId,
        subtleSource: this.crypto,
      });
    } catch (error) {
      // Deliberately one message for every failure mode. A decryption oracle
      // that distinguishes "wrong key" from "tampered" is a gift to an
      // attacker, and neither answer helps the operator.
      this.#status("run-status", messageFor(error), "error");
      return;
    }
    if (!result || result.schema !== "gmx-research-result/1") {
      this.#status("run-status", "Das Ergebnis hat ein unbekanntes Format.", "error");
      return;
    }

    this.session.setResult(result);
    this.#status("run-status", "");
    const container = this.$("results");
    container.replaceChildren(renderResults(this.doc, result));
    this.#setStep("results");
  }

  // -- starting over -----------------------------------------------------

  resetForNewResearch() {
    this.#stopPolling();
    // The old key pair and the old result go now, not when the next run
    // overwrites them.
    this.session.startResearch(null, null);
    this.session.researchId = null;
    this.$("results").replaceChildren();
    this.#status("run-status", "");
    this.#setStep("research");
  }
}

/** A message a non-technical reader can act on. Never a raw error object. */
export function messageFor(error) {
  if (error instanceof GitHubError) {
    return error.message;
  }
  if (error instanceof CryptoError) {
    return "Ergebnis konnte nicht sicher entschlüsselt werden.";
  }
  return "Es ist ein unerwarteter Fehler aufgetreten.";
}
