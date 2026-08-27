// Phase 7 in the browser: selecting hits, confirming, reporting the outcome.
//
// The properties under test are the ones a mistake here would be expensive
// for. A selection bound to a subject would copy the wrong mail. A control
// that ticks everything would turn 200 hits into 200 copies. A report that
// says "verschoben" would tell the operator their originals had moved.
//
// None of that is caught by the backend, because by then the order is already
// well-formed - it is only caught here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  confirmationText,
  hitIdentity,
  identityKey,
  renderCopyReport,
  renderHit,
  renderResults,
  selectionSummary,
} from "../src/render.js";
import { defaultDestinationFolder, validateDestination } from "../src/app.js";
import { createStubDocument } from "./dom-stub.mjs";

const XSS = "<script>alert(1)</script>";
const SEP = "\u0000";

function hit(overrides = {}) {
  return {
    message_uid: "42",
    uid_validity: 12345,
    folder: "INBOX",
    message_id: "<abc@example.com>",
    subject: "Verzögerung der Planung",
    sender: "planer@example.com",
    recipients: [],
    date: "2026-05-14T09:30:00+00:00",
    relevance_score: 94,
    reasons: [],
    reason_details: [],
    evidence: [],
    pdf_relevant: false,
    attachment_names: [],
    warnings: [],
    ...overrides,
  };
}

function result(hits) {
  return {
    schema: "gmx-research-result/1",
    research_id: "r-20260514-abcd1234",
    generated_at: "2026-05-14T10:00:00+00:00",
    query: "Verzug",
    counts: { candidates: hits.length, scored: hits.length, hits: hits.length, messages_read: 9 },
    truncated: false,
    partial: false,
    hits,
    warnings: [],
  };
}

function checkboxes(node) {
  return [...node.walk()].filter(
    (child) => child.tagName === "INPUT" && child.getAttribute("type") === "checkbox",
  );
}

function readSource(name) {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

// --- identity ---------------------------------------------------------------

test("a selection is keyed on folder, uid_validity and uid - never the subject", () => {
  const id = hitIdentity(hit());
  assert.deepEqual(Object.keys(id).sort(), ["folder", "message_id", "uid", "uid_validity"]);
  assert.equal("subject" in id, false);
  assert.equal(id.uid, 42);
  assert.equal(id.uid_validity, 12345);
  assert.equal(id.message_id, "<abc@example.com>");
});

test("two messages with the same subject have different keys", () => {
  const a = hit({ message_uid: "1", message_id: "<a@x>" });
  const b = hit({ message_uid: "2", message_id: "<b@x>" });
  assert.notEqual(identityKey(a), identityKey(b));
});

test("the same subject in two folders does not collapse into one key", () => {
  assert.notEqual(identityKey(hit({ folder: "INBOX" })), identityKey(hit({ folder: "Archiv" })));
});

test("a renumbered mailbox produces a different key for the same uid", () => {
  assert.notEqual(identityKey(hit({ uid_validity: 1 })), identityKey(hit({ uid_validity: 2 })));
});

test("a missing uid_validity is carried as null, not invented", () => {
  assert.equal(hitIdentity(hit({ uid_validity: undefined })).uid_validity, null);
  assert.equal(hitIdentity(hit({ uid_validity: null })).uid_validity, null);
});

// --- selection --------------------------------------------------------------

test("nothing is selected when the results are rendered", () => {
  const doc = createStubDocument();
  const node = renderResults(doc, result([hit(), hit({ message_uid: "43" })]), {
    selectable: true,
  });
  const boxes = checkboxes(node);
  assert.equal(boxes.length, 2);
  assert.equal(
    boxes.every((box) => box.checked === false),
    true,
  );
});

test("a score of 100 selects nothing", () => {
  const doc = createStubDocument();
  const node = renderResults(doc, result([hit({ relevance_score: 100 })]), { selectable: true });
  assert.equal(checkboxes(node)[0].checked, false);
});

test("two hundred hits render two hundred unticked boxes", () => {
  const doc = createStubDocument();
  const hits = Array.from({ length: 200 }, (_unused, index) =>
    hit({ message_uid: String(index), message_id: `<m${index}@x>` }),
  );
  const node = renderResults(doc, result(hits), { selectable: true });
  const boxes = checkboxes(node);
  assert.equal(boxes.length, 200);
  assert.equal(boxes.filter((box) => box.checked).length, 0);
});

test("no source file offers a way to select every hit at once", () => {
  for (const name of ["../src/render.js", "../src/app.js", "../index.html"]) {
    const text = readSource(name);
    assert.equal(/select[-_ ]?all/i.test(text), false, name);
    assert.equal(/alle\s+(Treffer|Nachrichten)\s+(kopieren|auswählen)/i.test(text), false, name);
  }
});

test("a toggle handler is invoked with the key, the state and the hit", () => {
  const doc = createStubDocument();
  const seen = [];
  const one = hit();
  const card = renderHit(doc, one, 0, {
    selectable: true,
    onToggle: (...args) => seen.push(args),
  });
  const box = checkboxes(card)[0];
  assert.equal(seen.length, 0, "rendering alone must not select anything");
  // The stub does not dispatch events, so the listener is called the way the
  // change event would call it - what matters is the arguments it passes on.
  box.checked = true;
  box.listeners.change();
  assert.deepEqual(seen, [[identityKey(one), true, one]]);
});

test("the results are not selectable unless asked", () => {
  const doc = createStubDocument();
  assert.equal(checkboxes(renderResults(doc, result([hit()]))).length, 0);
});

test("each checkbox carries its own identity key", () => {
  const doc = createStubDocument();
  const node = renderResults(doc, result([hit({ message_uid: "1" }), hit({ message_uid: "2" })]), {
    selectable: true,
  });
  const keys = checkboxes(node).map((box) => box.getAttribute("data-key"));
  assert.equal(new Set(keys).size, 2);
  for (const key of keys) {
    assert.deepEqual(key.split(SEP).slice(0, 2), ["INBOX", "12345"]);
  }
});

// --- the count and the confirmation -----------------------------------------

test("the count is stated, including when it is zero", () => {
  assert.equal(selectionSummary(0), "Keine Nachricht ausgewählt.");
  assert.equal(selectionSummary(1), "1 Nachricht ausgewählt");
  assert.equal(selectionSummary(3), "3 Nachrichten ausgewählt");
});

test("the confirmation names the count and the destination", () => {
  const text = confirmationText(3, "Recherche r-1");
  assert.match(text, /3 Originalnachrichten/);
  assert.match(text, /Recherche r-1/);
});

test("the confirmation promises the originals are untouched", () => {
  const text = confirmationText(3, "Recherche r-1");
  assert.match(text, /nicht verändert/);
  assert.match(text, /nicht verschoben/);
  assert.match(text, /nicht gelöscht/);
});

test("the confirmation says copied", () => {
  assert.match(confirmationText(1, "Ordner"), /kopiert/);
});

test("a single message is described in the singular", () => {
  assert.match(confirmationText(1, "Ordner"), /Es wird 1 Originalnachricht in/);
});

// --- the destination folder -------------------------------------------------

test("the proposed folder is unique per research", () => {
  assert.equal(defaultDestinationFolder("r-20260514-abcd1234"), "Recherche r-20260514-abcd1234");
});

test("the proposed folder is one the validation accepts", () => {
  assert.equal(validateDestination(defaultDestinationFolder("r-20260514-abcd1234")), null);
});

test("an empty destination is refused", () => {
  assert.equal(typeof validateDestination(""), "string");
  assert.equal(typeof validateDestination("   "), "string");
});

for (const [label, name] of [
  ["a CRLF and a trailing IMAP command", "Recherche\r\nA0001 LOGOUT"],
  ["a bare carriage return", "Recherche\rX"],
  ["a bare newline", "Recherche\nX"],
  ["a control character", "Recherche\u0007X"],
  ["a NUL", "Recherche\u0000X"],
  ["path traversal", "../andere"],
  ["a parent segment", "Recherche/../INBOX"],
  ["a current-directory segment", "Recherche/./X"],
  ["a double quote", 'Recherche"X"'],
  ["an IMAP literal brace", "Recherche{3}"],
  ["a wildcard", "Recherche*"],
  ["a percent wildcard", "Recherche%"],
  ["a backslash", "Recherche\\X"],
  ["five levels", "a/b/c/d/e"],
  ["an empty segment", "Recherche//X"],
  ["an over-long name", "x".repeat(300)],
  ["an over-long segment", `${"x".repeat(65)}`],
]) {
  test(`a destination containing ${label} is refused`, () => {
    assert.equal(typeof validateDestination(name), "string", `accepted: ${JSON.stringify(name)}`);
  });
}

test("an ordinary German folder name is accepted", () => {
  assert.equal(validateDestination("Recherche r-20260514-abcd1234"), null);
  assert.equal(validateDestination("Recherche/Bauvorhaben (2026)"), null);
  assert.equal(validateDestination("Verzögerung_Planung"), null);
});

// --- the report -------------------------------------------------------------

function report(overrides = {}) {
  return {
    schema: "gmx-copy-report/1",
    research_id: "r-20260514-abcd1234",
    destination_folder: "Recherche r-20260514-abcd1234",
    destination_created: true,
    outcomes: [
      { ref: { folder: "INBOX", uid: 42, uid_validity: 12345 }, status: "copied", detail: null },
    ],
    ...overrides,
  };
}

test("the report states the four numbers", () => {
  const doc = createStubDocument();
  const node = renderCopyReport(
    doc,
    report({
      outcomes: [
        { ref: { folder: "INBOX", uid: 1, uid_validity: 1 }, status: "copied" },
        { ref: { folder: "INBOX", uid: 2, uid_validity: 1 }, status: "copied" },
        { ref: { folder: "INBOX", uid: 3, uid_validity: 1 }, status: "already_present" },
        { ref: { folder: "INBOX", uid: 4, uid_validity: 1 }, status: "not_found" },
      ],
    }),
  );
  const text = node.allText();
  assert.match(text, /4 Nachrichten ausgewählt/);
  assert.match(text, /2 Nachrichten kopiert/);
  assert.match(text, /1 bereits vorhanden/);
  assert.match(text, /1 fehlgeschlagen/);
});

test("the report names the destination folder and whether it was created", () => {
  const doc = createStubDocument();
  const text = renderCopyReport(doc, report()).allText();
  assert.match(text, /Zielordner: Recherche r-20260514-abcd1234 \(neu angelegt\)/);
});

test("an existing destination is not reported as newly created", () => {
  const doc = createStubDocument();
  const text = renderCopyReport(doc, report({ destination_created: false })).allText();
  assert.equal(/neu angelegt/.test(text), false);
});

test("a partial failure lists the messages that did not make it", () => {
  const doc = createStubDocument();
  const outcomes = [
    { ref: { folder: "INBOX", uid: 1, uid_validity: 7 }, status: "copied" },
    {
      ref: { folder: "INBOX", uid: 9, uid_validity: 7 },
      status: "not_found",
      detail: "UID nicht mehr vorhanden",
    },
  ];
  const hits = new Map([[["INBOX", "7", "9"].join(SEP), hit({ subject: "Nachtrag 4" })]]);
  const text = renderCopyReport(doc, report({ outcomes }), hits).allText();
  assert.match(text, /Nachtrag 4/);
  assert.match(text, /nicht mehr eindeutig auffindbar/);
  assert.match(text, /UID nicht mehr vorhanden/);
  assert.match(text, /Bereits erfolgreiche Kopien/);
});

test("a failed message without a matching hit is still named by uid", () => {
  const doc = createStubDocument();
  const outcomes = [{ ref: { folder: "INBOX", uid: 9, uid_validity: 7 }, status: "failed" }];
  assert.match(renderCopyReport(doc, report({ outcomes })).allText(), /UID 9/);
});

test("the report says copied, never moved", () => {
  const doc = createStubDocument();
  assert.match(renderCopyReport(doc, report()).allText(), /kopiert, nicht verschoben/);
});

test("a hostile subject in the failure list stays text", () => {
  const doc = createStubDocument();
  const hits = new Map([[["INBOX", "7", "9"].join(SEP), hit({ subject: XSS })]]);
  const node = renderCopyReport(
    doc,
    report({ outcomes: [{ ref: { folder: "INBOX", uid: 9, uid_validity: 7 }, status: "failed" }] }),
    hits,
  );
  assert.equal(node.tags().includes("SCRIPT"), false);
  assert.match(node.allText(), /<script>/);
});

test("a hostile folder name in the report stays text", () => {
  const doc = createStubDocument();
  const node = renderCopyReport(doc, report({ destination_folder: XSS }));
  assert.equal(node.tags().includes("SCRIPT"), false);
  assert.match(node.allText(), /<script>/);
});

test("an empty outcome list reports zero rather than crashing", () => {
  const doc = createStubDocument();
  assert.match(renderCopyReport(doc, report({ outcomes: [] })).allText(), /0 Nachrichten kopiert/);
});

test("an unknown status is shown as itself rather than swallowed", () => {
  const doc = createStubDocument();
  const outcomes = [{ ref: { folder: "INBOX", uid: 1, uid_validity: 1 }, status: "weird" }];
  const text = renderCopyReport(doc, report({ outcomes })).allText();
  assert.match(text, /1 fehlgeschlagen/);
  assert.match(text, /weird/);
});

// --- the markup the application wires up ------------------------------------

test("index.html carries every element the copy flow addresses", () => {
  const html = readSource("../index.html");
  for (const id of [
    "destination",
    "allow-existing",
    "selection-count",
    "start-copy",
    "copy-confirm-box",
    "copy-confirm-text",
    "confirm-copy",
    "cancel-copy",
    "copy-status",
    "copy-result",
  ]) {
    assert.equal(html.includes(`id="${id}"`), true, `missing id="${id}"`);
  }
});

test("the copy button starts disabled and the confirmation starts hidden", () => {
  const html = readSource("../index.html");
  assert.match(html, /id="start-copy"[^>]*\n?[^>]*disabled/);
  assert.match(html, /id="copy-confirm-box"[\s\S]{0,300}?hidden/);
});
