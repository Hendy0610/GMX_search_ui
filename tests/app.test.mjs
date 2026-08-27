// The application's own decisions: ids, payloads, validation, run states.
//
// The DOM wiring is not exercised here - it is a thin layer over the pieces
// each tested on their own. What is tested is everything that could silently
// produce a wrong request or a misleading status.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPayload,
  describeRunState,
  messageFor,
  newResearchId,
  splitList,
  validateForm,
} from "../src/app.js";
import { GitHubError } from "../src/github.js";
import { CryptoError } from "../src/crypto.js";

// --- research ids -----------------------------------------------------------

test("a research id is dated and random", () => {
  const id = newResearchId(new Date(Date.UTC(2026, 4, 14)));
  assert.match(id, /^r-20260514-[a-z0-9]{8}$/);
});

test("two ids are never the same", () => {
  const ids = new Set(
    Array.from({ length: 200 }, () => newResearchId(new Date(Date.UTC(2026, 4, 14)))),
  );
  assert.equal(ids.size, 200);
});

test("ids match the pattern the backend accepts", () => {
  // RESEARCH_ID_RE in app/models/research.py
  const backendPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;
  for (let i = 0; i < 50; i += 1) {
    assert.match(newResearchId(), backendPattern);
  }
});

test("an id can never address a file outside the results branch", () => {
  for (let i = 0; i < 50; i += 1) {
    const id = newResearchId();
    assert.equal(id.includes("/"), false);
    assert.equal(id.includes(".."), false);
  }
});

// --- payloads ---------------------------------------------------------------

test("the payload carries only fields the backend understands", () => {
  const payload = buildPayload({
    query: "Verzug",
    dateFrom: "2025-01-01",
    dateTo: "2025-12-31",
    senders: "a@example.com, B@Example.com",
    folders: "INBOX, Archiv",
  });
  assert.deepEqual(Object.keys(payload).sort(), ["filters", "query", "schema"]);
  assert.deepEqual(Object.keys(payload.filters).sort(), [
    "date_from",
    "date_to",
    "folders",
    "senders",
  ]);
  assert.equal(payload.schema, "gmx-research-request/1");
});

test("sender addresses are lower-cased, as the backend stores them", () => {
  const payload = buildPayload({ query: "x", senders: "Planer@Example.COM" });
  assert.deepEqual(payload.filters.senders, ["planer@example.com"]);
});

test("empty filters become null and empty lists, not missing keys", () => {
  const payload = buildPayload({ query: "x" });
  assert.equal(payload.filters.date_from, null);
  assert.equal(payload.filters.date_to, null);
  assert.deepEqual(payload.filters.senders, []);
  assert.deepEqual(payload.filters.folders, []);
});

test("lists accept commas, semicolons and newlines", () => {
  assert.deepEqual(splitList("a@x.de, b@x.de; c@x.de\nd@x.de"), [
    "a@x.de",
    "b@x.de",
    "c@x.de",
    "d@x.de",
  ]);
  assert.deepEqual(splitList("  "), []);
  assert.deepEqual(splitList(undefined), []);
});

test("no mail content is ever put into a payload", () => {
  const payload = buildPayload({ query: "Verzug" });
  const serialised = JSON.stringify(payload);
  for (const forbidden of ["ciphertext", "body", "attachment", "snippet"]) {
    assert.equal(serialised.includes(forbidden), false);
  }
});

// --- validation -------------------------------------------------------------

test("an empty request is refused before a run is spent", () => {
  assert.match(validateForm({ query: "" })[0], /beschreiben/i);
  assert.match(validateForm({ query: "   " })[0], /beschreiben/i);
});

test("a valid request has no complaints", () => {
  assert.deepEqual(
    validateForm({
      query: "Verzug bei der Planung",
      dateFrom: "2025-01-01",
      dateTo: "2025-06-30",
      senders: "planer@example.com",
    }),
    [],
  );
});

test("reversed dates are caught here, as the backend would catch them", () => {
  const problems = validateForm({ query: "x", dateFrom: "2025-12-31", dateTo: "2025-01-01" });
  assert.match(problems[0], /Startdatum/);
});

test("an unusable sender address is named", () => {
  const problems = validateForm({ query: "x", senders: "nicht--eine-adresse" });
  assert.match(problems[0], /Absenderadresse/);
  assert.ok(problems[0].includes("nicht--eine-adresse"));
});

test("several problems are all reported, not just the first", () => {
  const problems = validateForm({
    query: "",
    dateFrom: "2025-12-31",
    dateTo: "2025-01-01",
    senders: "bad",
  });
  assert.equal(problems.length, 3);
});

// --- run states -------------------------------------------------------------

test("every workflow state maps to something readable", () => {
  const cases = [
    [null, "starting"],
    [{ status: "queued" }, "queued"],
    [{ status: "in_progress" }, "running"],
    [{ status: "waiting" }, "running"],
    [{ status: "completed", conclusion: "success" }, "success"],
    [{ status: "completed", conclusion: "failure" }, "failed"],
    [{ status: "completed", conclusion: "cancelled" }, "failed"],
    [{ status: "completed", conclusion: "timed_out" }, "failed"],
  ];
  for (const [run, expected] of cases) {
    const described = describeRunState(run);
    assert.equal(described.state, expected, JSON.stringify(run));
    assert.ok(described.text.length > 0);
  }
});

test("a failed run is never described as successful", () => {
  const described = describeRunState({ status: "completed", conclusion: "failure" });
  assert.equal(described.state, "failed");
  assert.equal(described.text.toLowerCase().includes("erfolgreich"), false);
});

// --- error messages ---------------------------------------------------------

test("a GitHub error keeps its actionable message", () => {
  assert.equal(messageFor(new GitHubError("Token abgelehnt.", { kind: "auth" })), "Token abgelehnt.");
});

test("a crypto failure says nothing about why", () => {
  // Distinguishing "wrong key" from "tampered" is a decryption oracle, and
  // neither answer helps the operator.
  const message = messageFor(new CryptoError("wrong key or tampered data"));
  assert.match(message, /nicht sicher entschlüsselt/);
  assert.equal(message.includes("tampered"), false);
});

test("an unknown error does not leak its contents", () => {
  const message = messageFor(new Error("connect ECONNREFUSED token=TEST-TOKEN-leaked"));
  assert.equal(message.includes("TEST-TOKEN-leaked"), false);
  assert.match(message, /unerwarteter Fehler/);
});
