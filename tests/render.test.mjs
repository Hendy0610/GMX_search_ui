// Rendering, and the one property that matters most: mail content is text.
//
// Every string here arrives from a mailbox in a legal dispute - a place where a
// hostile subject line is not a theoretical concern. By the time it reaches
// render.js it has been decrypted and is, structurally, trusted data. So the
// tests below feed it exactly what an attacker would.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BAND_LABELS,
  bandFor,
  formatDate,
  formatWeight,
  partialNotice,
  renderEmpty,
  renderHit,
  renderQueryPreview,
  renderResults,
  renderSummary,
  sourceLabel,
  summaryLines,
  truncationNotice,
} from "../src/render.js";
import { previewQuery } from "../src/query-preview.js";
import { createStubDocument } from "./dom-stub.mjs";

const XSS = '<script>alert(1)</script>';
const IMG_XSS = '<img src=x onerror="alert(1)">';

function hit(overrides = {}) {
  return {
    message_uid: "42",
    folder: "INBOX",
    message_id: "<abc@example.com>",
    subject: "Verzögerung der Planung",
    sender: "planer@example.com",
    recipients: ["bauherr@example.com"],
    date: "2026-05-14T09:30:00+00:00",
    relevance_score: 94,
    reasons: ["Suchbegriff im Betreff"],
    reason_details: [
      {
        code: "term_subject",
        description: "Suchbegriff im Betreff",
        weight: 1.25,
        source: "subject",
        matched_terms: ["verzogerung"],
      },
    ],
    evidence: [{ source: "email", snippet: "… wir liegen im Verzug …", location: null }],
    pdf_relevant: false,
    attachment_names: [],
    warnings: [],
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    schema: "gmx-research-result/1",
    research_id: "r-20260514-abcd1234",
    query: "Verzögerungen",
    status: "success",
    hits: [hit()],
    statistics: { candidates: 184, scored: 67, messages_examined: 900, truncated: false },
    errors: [],
    ...overrides,
  };
}

// --- XSS: the whole point ---------------------------------------------------

test("a script tag in the subject stays text", () => {
  const doc = createStubDocument();
  const node = renderHit(doc, hit({ subject: XSS }), 0);
  assert.equal(node.tags().includes("SCRIPT"), false);
  assert.ok(node.allText().includes(XSS));
});

test("a script tag in the sender stays text", () => {
  const doc = createStubDocument();
  const node = renderHit(doc, hit({ sender: IMG_XSS }), 0);
  assert.equal(node.tags().includes("IMG"), false);
  assert.ok(node.allText().includes(IMG_XSS));
});

test("a script tag in a snippet stays text", () => {
  const doc = createStubDocument();
  const node = renderHit(
    doc,
    hit({ evidence: [{ source: "pdf", snippet: XSS, location: IMG_XSS }] }),
    0,
  );
  assert.equal(node.tags().includes("SCRIPT"), false);
  assert.ok(node.allText().includes(XSS));
});

test("a script tag in an attachment name stays text", () => {
  const doc = createStubDocument();
  const node = renderHit(
    doc,
    hit({ attachment_names: [`${XSS}.pdf`], pdf_relevant: true }),
    0,
  );
  assert.equal(node.tags().includes("SCRIPT"), false);
  assert.ok(node.allText().includes(XSS));
});

test("hostile values in every detail field stay text", () => {
  const doc = createStubDocument();
  const node = renderHit(
    doc,
    hit({
      folder: XSS,
      message_id: XSS,
      recipients: [XSS],
      reasons: [XSS],
      warnings: [XSS],
      reason_details: [{ description: XSS, weight: 1, source: "pdf", matched_terms: [XSS] }],
    }),
    0,
  );
  assert.equal(node.tags().includes("SCRIPT"), false);
  assert.equal(node.tags().includes("IMG"), false);
});

test("a hostile query is not markup in the preview either", () => {
  const doc = createStubDocument();
  const node = renderQueryPreview(doc, previewQuery(`${XSS} Verzoegerung Planung`));
  assert.equal(node.tags().includes("SCRIPT"), false);
});

// --- score bands and wording ------------------------------------------------

test("bands follow the backend thresholds", () => {
  assert.equal(bandFor(94), "high");
  assert.equal(bandFor(70), "high");
  assert.equal(bandFor(69), "medium");
  assert.equal(bandFor(40), "medium");
  assert.equal(bandFor(39), "low");
  assert.equal(bandFor(0), "low");
});

test("no band label claims legal meaning", () => {
  const forbidden = [
    "juristisch",
    "rechtlich",
    "beweis",
    "wahrscheinlich",
    "relevant",
  ];
  for (const label of Object.values(BAND_LABELS)) {
    for (const word of forbidden) {
      assert.equal(
        label.toLowerCase().includes(word),
        false,
        `"${label}" must not contain "${word}"`,
      );
    }
  }
});

test("the summary distinguishes candidates, scored and shown", () => {
  const lines = summaryLines(result());
  assert.ok(lines.some((line) => line.includes("184 Kandidaten")));
  assert.ok(lines.some((line) => line.includes("67 Nachrichten bewertet")));
  assert.ok(lines.some((line) => line.includes("1 Treffer angezeigt")));
});

test("the summary never claims completeness", () => {
  const doc = createStubDocument();
  const text = renderSummary(doc, result()).allText().toLowerCase();
  assert.equal(text.includes("alle relevanten"), false);
  assert.ok(text.includes("keine rechtliche bewertung"));
});

// --- truncation and partial results ----------------------------------------

test("a complete run reports no truncation", () => {
  assert.equal(truncationNotice(result()), null);
});

test("truncation is stated as a fact about the list", () => {
  const notice = truncationNotice(
    result({ statistics: { truncated: true, truncation_reason: "result cap" } }),
  );
  assert.ok(notice.title.includes("bestbewerteten"));
  assert.ok(notice.detail.includes("Weitere Kandidaten"));
});

test("a partial run is not presented as success", () => {
  const doc = createStubDocument();
  const partial = result({
    status: "partial",
    statistics: { candidates: 10, scored: 5, messages_skipped: 3, pdfs_failed: 2, warnings: 7 },
  });
  const text = renderSummary(doc, partial).allText();
  assert.ok(text.includes("teilweise abgeschlossen"));
  assert.ok(text.includes("3 Nachrichten konnten nicht gelesen werden"));
  assert.ok(text.includes("2 PDF-Anhänge konnten nicht ausgewertet werden"));
  assert.ok(text.includes("7 Warnungen"));
});

test("partialNotice stays silent for a successful run", () => {
  assert.equal(partialNotice(result()), null);
});

// --- the empty case ---------------------------------------------------------

test("no hits does not mean nothing exists", () => {
  const doc = createStubDocument();
  const text = renderEmpty(doc).allText();
  assert.ok(text.includes("Keine Kandidaten gefunden"));
  assert.ok(text.includes("bedeutet nicht zwingend"));
  assert.ok(text.includes("deterministisch"));
});

test("an empty result renders the explanation, not an empty list", () => {
  const doc = createStubDocument();
  const node = renderResults(doc, result({ hits: [] }));
  assert.ok(node.allText().includes("Keine Kandidaten gefunden"));
});

// --- ordering and formatting ------------------------------------------------

test("hits are rendered in the order the backend sorted them", () => {
  const doc = createStubDocument();
  const node = renderResults(
    doc,
    result({
      hits: [hit({ relevance_score: 94, subject: "A" }), hit({ relevance_score: 41, subject: "B" })],
    }),
  );
  const text = node.allText();
  assert.ok(text.indexOf("94 / 100") < text.indexOf("41 / 100"));
});

test("an unparsable date does not break the card", () => {
  assert.equal(formatDate(null), "ohne Datum");
  assert.equal(formatDate("not-a-date"), "ohne Datum");
});

test("weights are shown with their sign", () => {
  assert.equal(formatWeight(1.25), "+1.25");
  assert.equal(formatWeight(-0.5), "-0.5");
  assert.equal(formatWeight(undefined), "0");
});

test("evidence sources are named in the reader's language", () => {
  assert.equal(sourceLabel("pdf"), "PDF-Anhang");
  assert.equal(sourceLabel("subject"), "Betreff");
  assert.equal(sourceLabel("unknown-source"), "Mailtext");
});

test("a hit without a subject still renders", () => {
  const doc = createStubDocument();
  const node = renderHit(doc, hit({ subject: "", sender: "" }), 0);
  assert.ok(node.allText().includes("(ohne Betreff)"));
  assert.ok(node.allText().includes("(unbekannt)"));
});

test("the score breakdown appears in the details view", () => {
  const doc = createStubDocument();
  const text = renderHit(doc, hit(), 0).allText();
  assert.ok(text.includes("Wie der Score zustande kommt"));
  assert.ok(text.includes("+1.25"));
  assert.ok(text.includes("verzogerung"));
});
