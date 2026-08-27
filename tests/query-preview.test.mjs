// Deriving search terms from a prompt.
//
// Agreement with the Python implementation is proved separately and more
// strongly by tests/test_query_preview_parity.py, which runs both over a corpus.
// What is checked here is that the preview says the things the interface
// depends on it saying.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  directTerms,
  generatedVariants,
  previewQuery,
  thesaurusTerms,
} from "../src/query-preview.js";
import { normalizeTerm, searchVariants, stemVariants, umlautVariants } from "../src/text.js";

test("filler words are dropped and named", () => {
  const preview = previewQuery("Bitte finde alle Nachrichten über Verzögerungen");
  const words = directTerms(preview).map((term) => term.text);
  assert.ok(words.includes("verzogerungen"));
  assert.equal(words.includes("bitte"), false);
  assert.ok(preview.stopwordsRemoved.includes("bitte"));
});

test("umlauts are searched in both spellings", () => {
  const preview = previewQuery("Verzögerung");
  const variants = generatedVariants(preview);
  assert.ok(variants.includes("verzoegerung"));
});

test("a stem is generated for inflected words", () => {
  assert.deepEqual(stemVariants("Termine"), ["termin"]);
  assert.deepEqual(stemVariants("Planungen"), ["planung"]);
});

test("short stems are not generated", () => {
  // "kosten" -> "koste" would match half a construction mailbox.
  assert.deepEqual(stemVariants("Kosten"), []);
});

test("the thesaurus adds related terms and says where they came from", () => {
  const preview = previewQuery("Verzug bei der Planung");
  const synonyms = thesaurusTerms(preview);
  assert.ok(synonyms.length > 0);
  assert.ok(synonyms.some((term) => term.text === "fristuberschreitung"));
  for (const term of synonyms) {
    assert.ok(term.derivedFrom, "a synonym must name the word it came from");
    assert.equal(term.weight, 0.6);
  }
});

test("terms the user wrote weigh more than generated ones", () => {
  const preview = previewQuery("Verzug");
  assert.equal(directTerms(preview)[0].weight, 1);
  for (const term of thesaurusTerms(preview)) {
    assert.ok(term.weight < 1);
  }
});

test("quoted text becomes a phrase", () => {
  const preview = previewQuery('Nachrichten über "nicht eingehaltene Termine" und Fristen');
  assert.equal(preview.phrases.length, 1);
  assert.equal(preview.phrases[0].text, "nicht eingehaltene termine");
  // The phrase's words are not also searched individually.
  assert.equal(directTerms(preview).some((term) => term.text === "eingehaltene"), false);
});

test("a prompt with no usable word says so", () => {
  const preview = previewQuery("und der die das");
  assert.equal(preview.hasTerms, false);
  assert.ok(preview.stopwordsRemoved.length > 0);
});

test("an empty prompt is not an error", () => {
  const preview = previewQuery("");
  assert.equal(preview.hasTerms, false);
  assert.deepEqual(preview.terms, []);
});

test("duplicate words appear once", () => {
  const preview = previewQuery("Verzug Verzug VERZUG");
  assert.equal(directTerms(preview).filter((term) => term.text === "verzug").length, 1);
});

test("normalisation folds case, diacritics and the sharp s", () => {
  assert.equal(normalizeTerm("Verzögerung"), "verzogerung");
  assert.equal(normalizeTerm("STRASSE"), "strasse");
  assert.equal(normalizeTerm("Straße"), "strasse");
  assert.equal(normalizeTerm("  mehrere   Wörter  "), "mehrere worter");
});

test("umlaut variants go in both directions", () => {
  assert.ok(umlautVariants("Verzögerung").includes("verzoegerung"));
  assert.ok(umlautVariants("Verzoegerung").includes("verzogerung"));
});

test("a variant of a variant is generated too", () => {
  // "verspaetete" -> "verspaetet" via the stem of the umlaut spelling.
  assert.ok(searchVariants("verspätete").includes("verspaetet"));
});

test("the number of variants per term is capped", () => {
  const preview = previewQuery("Verzögerungen", { maxVariantsPerTerm: 1 });
  for (const term of preview.terms) {
    assert.ok(term.variants.length <= 1);
  }
});

test("the thesaurus can be switched off", () => {
  const preview = previewQuery("Verzug", { useThesaurus: false });
  assert.deepEqual(thesaurusTerms(preview), []);
});
