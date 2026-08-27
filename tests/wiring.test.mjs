// The application against the ids the page actually has.
//
// This file exists because of a specific failure. The selection feature was
// implemented, tested and correct, and a research run was nevertheless carried
// out on an interface with no checkboxes in it: the browser was running an
// older build. Nothing in the suite could have said so, because every test
// called `render.js` directly. Between `render.js` and what a person sees sat
// two untested layers - the application's own wiring, and the markup it wires
// itself to.
//
// So these tests never call the rendering functions directly. They build a
// document out of the real index.html, drive the App the way a run drives it,
// and assert on what ends up in that document. A rendering function that works
// perfectly while the application never calls it fails here.
//
// What this still cannot see: whether an element is *visible*. That is a
// browser question and is answered in a browser - see docs/frontend.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { App } from "../src/app.js";
import { createPageStub, createStubDocument } from "./dom-stub.mjs";

const INDEX = fileURLToPath(new URL("../index.html", import.meta.url));

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
  key(index) {
    return [...this.map.keys()][index] ?? null;
  }
  get length() {
    return this.map.size;
  }
}

function hit(uid, overrides = {}) {
  return {
    message_uid: String(uid),
    uid_validity: 12345,
    folder: "INBOX",
    message_id: `<m${uid}@example.com>`,
    subject: "GMX COPY Test 2026-08-28",
    sender: "test@example.com",
    recipients: [],
    date: "2026-08-28T09:00:00+00:00",
    relevance_score: 97,
    reasons: ["Suchbegriff im Betreff"],
    reason_details: [],
    evidence: [],
    pdf_relevant: false,
    attachment_names: [],
    warnings: [],
    ...overrides,
  };
}

function researchResult(hits) {
  return {
    schema: "gmx-research-result/1",
    research_id: "r-20260828-testtest",
    generated_at: "2026-08-28T09:05:00+00:00",
    query: "GMX COPY Test",
    counts: { candidates: hits.length, scored: hits.length, hits: hits.length, messages_read: 5 },
    truncated: false,
    partial: false,
    hits,
    warnings: [],
  };
}

/** An App on the real page, with the result already decrypted and shown. */
function appShowingResult(hits) {
  const { doc } = createPageStub(INDEX);
  const app = new App(doc, { storage: new MemoryStorage() });
  assert.equal(app.start(), true, "start() must succeed against the real markup");
  app.showResult(researchResult(hits), "r-20260828-testtest");
  return { app, doc };
}

/** Every id present in a chunk of markup. */
function idsIn(html) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
}

function checkboxesIn(node) {
  return [...node.walk()].filter(
    (child) => child.tagName === "INPUT" && child.getAttribute("type") === "checkbox",
  );
}

// --- the markup and the application agree -----------------------------------

test("every id the application addresses exists in index.html", () => {
  const { doc } = createPageStub(INDEX);
  const app = new App(doc, { storage: new MemoryStorage() });
  assert.deepEqual(app.missingElements(), []);
});

test("start() succeeds against the real page", () => {
  const { doc } = createPageStub(INDEX);
  const app = new App(doc, { storage: new MemoryStorage() });
  assert.equal(app.start(), true);
});

test("a page missing the selection markup is reported, not crashed through", () => {
  // Exactly the incident: current scripts, an older cached page.
  const doc = createStubDocument();
  for (const id of ["connect-form", "disconnect", "research-form", "query", "results",
                    "new-research"]) {
    doc._register(id, doc.createElement("div"));
  }
  const app = new App(doc, { storage: new MemoryStorage() });
  assert.equal(app.start(), false);
  assert.ok(app.missingElements().includes("start-copy"));
  const banner = doc.body.children.find((node) => node.className === "stale-page");
  assert.ok(banner, "the operator must be told the page is stale");
  assert.match(banner.allText(), /veraltet/);
  assert.match(banner.allText(), /neu/);
});

test("the running build is named on the page", () => {
  const { doc } = createPageStub(INDEX);
  new App(doc, { storage: new MemoryStorage() }).start();
  assert.match(doc.getElementById("ui-version").textContent, /Phase 7/);
});

// --- what a real result puts on the page ------------------------------------

test("a rendered hit carries a checkbox", () => {
  const { doc } = appShowingResult([hit(101)]);
  assert.equal(checkboxesIn(doc.getElementById("results")).length, 1);
});

test("every hit carries its own checkbox", () => {
  const { doc } = appShowingResult([hit(101), hit(105), hit(109)]);
  assert.equal(checkboxesIn(doc.getElementById("results")).length, 3);
});

test("the checkbox is labelled for what it does", () => {
  const { doc } = appShowingResult([hit(101)]);
  const labels = [...doc.getElementById("results").walk()].filter(
    (node) => node.className === "hit-select-label",
  );
  assert.equal(labels.length, 1);
  assert.match(labels[0].textContent, /Rechercheordner/);
  // The label points at its own box, so clicking the text ticks it.
  assert.equal(labels[0].getAttribute("for"), checkboxesIn(doc.getElementById("results"))[0].getAttribute("id"));
});

test("nothing is ticked when a result arrives", () => {
  const { app, doc } = appShowingResult([hit(101), hit(105)]);
  assert.equal(
    checkboxesIn(doc.getElementById("results")).every((box) => !box.checked),
    true,
  );
  assert.equal(app.selection.size, 0);
});

test("a hit scoring 97 is not selected for the user", () => {
  const { app, doc } = appShowingResult([hit(101, { relevance_score: 97 })]);
  assert.equal(app.selection.size, 0);
  assert.equal(checkboxesIn(doc.getElementById("results"))[0].checked, false);
});

test("a hit scoring 100 is not selected either", () => {
  const { app } = appShowingResult([hit(101, { relevance_score: 100 })]);
  assert.equal(app.selection.size, 0);
});

// --- ticking, untickng, counting --------------------------------------------

/** Tick a checkbox the way the browser would: set it, then fire change. */
function tick(box, checked) {
  box.checked = checked;
  box.listeners.change();
}

test("ticking one box selects exactly that message", () => {
  const { app, doc } = appShowingResult([hit(101), hit(105)]);
  const boxes = checkboxesIn(doc.getElementById("results"));
  tick(boxes[0], true);
  assert.equal(app.selection.size, 1);
  const [identity] = [...app.selection.values()];
  assert.deepEqual(identity, {
    folder: "INBOX",
    uid: 101,
    uid_validity: 12345,
    message_id: "<m101@example.com>",
  });
});

test("the selection carries identity, never the subject", () => {
  const { app, doc } = appShowingResult([hit(101)]);
  tick(checkboxesIn(doc.getElementById("results"))[0], true);
  const [identity] = [...app.selection.values()];
  assert.equal("subject" in identity, false);
  assert.equal(JSON.stringify(identity).includes("GMX COPY Test"), false);
});

test("two hits with the same subject are selected separately", () => {
  const { app, doc } = appShowingResult([hit(101), hit(105)]);
  const boxes = checkboxesIn(doc.getElementById("results"));
  tick(boxes[0], true);
  tick(boxes[1], true);
  assert.equal(app.selection.size, 2);
  assert.deepEqual(
    [...app.selection.values()].map((identity) => identity.uid).sort((a, b) => a - b),
    [101, 105],
  );
});

test("unticking removes exactly that message", () => {
  const { app, doc } = appShowingResult([hit(101), hit(105)]);
  const boxes = checkboxesIn(doc.getElementById("results"));
  tick(boxes[0], true);
  tick(boxes[1], true);
  tick(boxes[0], false);
  assert.equal(app.selection.size, 1);
  assert.equal([...app.selection.values()][0].uid, 105);
});

test("the count on the page follows the selection", () => {
  const { doc } = appShowingResult([hit(101), hit(105)]);
  const boxes = checkboxesIn(doc.getElementById("results"));
  const count = () => doc.getElementById("selection-count").textContent;

  assert.match(count(), /^0 Nachrichten ausgewählt/);
  tick(boxes[0], true);
  assert.equal(count(), "1 Nachricht ausgewählt");
  tick(boxes[1], true);
  assert.equal(count(), "2 Nachrichten ausgewählt");
  tick(boxes[1], false);
  assert.equal(count(), "1 Nachricht ausgewählt");
  tick(boxes[0], false);
  assert.match(count(), /^0 Nachrichten ausgewählt/);
});

test("the zero state says what to do about it", () => {
  const { doc } = appShowingResult([hit(101)]);
  assert.match(doc.getElementById("selection-count").textContent, /haken Sie .* an/);
});

// --- the copy area ----------------------------------------------------------

test("the copy controls are hidden and the button disabled without a selection", () => {
  const { doc } = appShowingResult([hit(101)]);
  assert.equal(doc.getElementById("copy-controls").hidden, true);
  assert.equal(doc.getElementById("start-copy").disabled, true);
});

test("the copy controls appear as soon as something is ticked", () => {
  const { doc } = appShowingResult([hit(101)]);
  tick(checkboxesIn(doc.getElementById("results"))[0], true);
  assert.equal(doc.getElementById("copy-controls").hidden, false);
  assert.equal(doc.getElementById("start-copy").disabled, false);
});

test("they disappear again when the last tick is removed", () => {
  const { doc } = appShowingResult([hit(101)]);
  const box = checkboxesIn(doc.getElementById("results"))[0];
  tick(box, true);
  tick(box, false);
  assert.equal(doc.getElementById("copy-controls").hidden, true);
  assert.equal(doc.getElementById("start-copy").disabled, true);
});

test("a destination is proposed once the result is shown", () => {
  const { doc } = appShowingResult([hit(101)]);
  assert.equal(doc.getElementById("destination").value, "Recherche r-20260828-testtest");
});

// --- the confirmation -------------------------------------------------------

test("the confirmation appears only on request and states what will happen", () => {
  const { app, doc } = appShowingResult([hit(101), hit(105)]);
  const boxes = checkboxesIn(doc.getElementById("results"));
  tick(boxes[0], true);
  tick(boxes[1], true);
  assert.equal(doc.getElementById("copy-confirm-box").hidden, true);

  app.requestCopyConfirmation();
  assert.equal(doc.getElementById("copy-confirm-box").hidden, false);
  const text = doc.getElementById("copy-confirm-text").textContent;
  assert.match(text, /2 Originalnachrichten/);
  assert.match(text, /Recherche r-20260828-testtest/);
  assert.match(text, /kopiert/);
  assert.match(text, /nicht verändert/);
  assert.match(text, /nicht verschoben/);
  assert.match(text, /nicht gelöscht/);
});

test("opening the confirmation focuses the dialog, never the copy button", () => {
  // The bug this replaces: the button that copies took focus the moment the
  // dialog opened, so the keypress that opened it could confirm it. The
  // dialog itself is not activatable - a key press on it does nothing.
  const { app, doc } = appShowingResult([hit(101)]);
  tick(checkboxesIn(doc.getElementById("results"))[0], true);
  app.requestCopyConfirmation();

  assert.equal(doc.activeElement, doc.getElementById("copy-confirm-box"));
  assert.notEqual(doc.activeElement, doc.getElementById("confirm-copy"));
  assert.notEqual(doc.activeElement, doc.getElementById("cancel-copy"));
});

test("the dialog is reachable by keyboard and announces itself", () => {
  const html = readFileSync(INDEX, "utf8");
  const tag = /<div[^>]*id="copy-confirm-box"[^>]*>/.exec(html)?.[0] ?? "";
  assert.match(tag, /tabindex="-1"/, "the dialog must be focusable programmatically");
  assert.match(tag, /role="alertdialog"/);
  assert.match(tag, /aria-labelledby="copy-confirm-heading"/);
  assert.match(tag, /aria-describedby="copy-confirm-text"/);
  assert.ok(idsIn(html).includes("copy-confirm-heading"), "the dialog needs a title");
});

test("escape inside the dialog cancels and copies nothing", () => {
  const { app, doc } = appShowingResult([hit(101)]);
  tick(checkboxesIn(doc.getElementById("results"))[0], true);
  app.requestCopyConfirmation();

  doc.getElementById("copy-confirm-box").dispatch("keydown", { key: "Escape" });
  assert.equal(doc.getElementById("copy-confirm-box").hidden, true);
  assert.match(doc.getElementById("copy-status").textContent, /nichts kopiert/);
  assert.equal(app.selection.size, 1, "escape must not clear the selection");
});

test("an unrelated key inside the dialog does nothing", () => {
  const { app, doc } = appShowingResult([hit(101)]);
  tick(checkboxesIn(doc.getElementById("results"))[0], true);
  app.requestCopyConfirmation();
  for (const key of ["Enter", " ", "a", "Tab"]) {
    doc.getElementById("copy-confirm-box").dispatch("keydown", { key });
  }
  assert.equal(doc.getElementById("copy-confirm-box").hidden, false, "still open");
});

test("cancelling puts focus back where it came from", () => {
  const { app, doc } = appShowingResult([hit(101)]);
  tick(checkboxesIn(doc.getElementById("results"))[0], true);
  app.requestCopyConfirmation();
  app.cancelCopy();
  assert.equal(doc.activeElement, doc.getElementById("start-copy"));
});

test("no confirmation without a selection", () => {
  const { app, doc } = appShowingResult([hit(101)]);
  app.requestCopyConfirmation();
  assert.equal(doc.getElementById("copy-confirm-box").hidden, true);
  assert.match(doc.getElementById("copy-status").textContent, /mindestens eine/);
});

test("an unusable destination stops the confirmation", () => {
  const { app, doc } = appShowingResult([hit(101)]);
  tick(checkboxesIn(doc.getElementById("results"))[0], true);
  doc.getElementById("destination").value = "../andere";
  app.requestCopyConfirmation();
  assert.equal(doc.getElementById("copy-confirm-box").hidden, true);
  assert.equal(doc.getElementById("copy-status").className.includes("error"), true);
});

test("cancelling closes the confirmation and copies nothing", () => {
  const { app, doc } = appShowingResult([hit(101)]);
  tick(checkboxesIn(doc.getElementById("results"))[0], true);
  app.requestCopyConfirmation();
  app.cancelCopy();
  assert.equal(doc.getElementById("copy-confirm-box").hidden, true);
  assert.match(doc.getElementById("copy-status").textContent, /nichts kopiert/);
  assert.equal(app.selection.size, 1, "cancelling must not clear the selection");
});

// --- untrusted content survives the whole path ------------------------------

test("a hostile subject reaching the page through the application stays text", () => {
  const { doc } = appShowingResult([hit(101, { subject: "<script>alert(1)</script>" })]);
  const results = doc.getElementById("results");
  assert.equal(results.tags().includes("SCRIPT"), false);
  assert.match(results.allText(), /<script>/);
});

test("a hostile folder name does not become the selection key's structure", () => {
  const { app, doc } = appShowingResult([hit(101, { folder: 'INBOX"; DELETE' })]);
  tick(checkboxesIn(doc.getElementById("results"))[0], true);
  const [identity] = [...app.selection.values()];
  // Carried verbatim as data. Validation is the runner's job, and it does it
  // again regardless of what arrives - the browser is never the authority.
  assert.equal(identity.folder, 'INBOX"; DELETE');
});

// --- a new research starts clean --------------------------------------------

test("starting a new research drops the selection and hides the copy controls", () => {
  const { app, doc } = appShowingResult([hit(101)]);
  tick(checkboxesIn(doc.getElementById("results"))[0], true);
  app.resetForNewResearch();
  assert.equal(app.selection.size, 0);
  assert.equal(doc.getElementById("copy-controls").hidden, true);
  assert.equal(doc.getElementById("results").children.length, 0);
});
