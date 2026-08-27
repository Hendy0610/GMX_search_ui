// What the runner will actually search for, computed before the run starts.
//
// This is the honest answer to "what does this tool do with my sentence?". The
// backend derives search terms from the prompt by a fixed set of rules - no
// model, no semantics - and the user is entitled to see the result of those
// rules *before* spending a workflow run on them.
//
// A hand port of build_query() in app/services/search_query.py, limited to the
// part that produces terms. Guarded against drift by
// tests/test_query_preview_parity.py, which runs both implementations over a
// corpus and compares.

import {
  QUERY_TERM_WEIGHT,
  RETRIEVAL_DEFAULTS,
  REVERSE_THESAURUS,
  STOPWORDS,
  THESAURUS,
  THESAURUS_TERM_WEIGHT,
} from "./query-data.js";
import { normalizeTerm, searchVariants, tokenize } from "./text.js";

const PHRASE_RE = /"([^"]{2,200})"/g;

/**
 * @typedef {object} PreviewTerm
 * @property {string} text canonical search form
 * @property {string} display what the user wrote, or the synonym
 * @property {"keyword"|"phrase"} kind
 * @property {"query"|"thesaurus"} origin
 * @property {string[]} variants generated spellings
 * @property {number} weight
 * @property {string|null} derivedFrom which query word produced a synonym
 */

function buildTerm(display, { kind, origin, maxVariants, derivedFrom = null }) {
  const canonical = normalizeTerm(display);
  if (!canonical) {
    return null;
  }
  return {
    text: canonical,
    display,
    kind,
    origin,
    variants: searchVariants(display).slice(0, maxVariants),
    weight: origin === "query" ? QUERY_TERM_WEIGHT : THESAURUS_TERM_WEIGHT,
    derivedFrom,
  };
}

/** Split a prompt into usable words and the words that were dropped. */
function selectWords(text, config) {
  const kept = [];
  const dropped = [];
  for (const token of tokenize(text)) {
    const canonical = normalizeTerm(token);
    if (!canonical) {
      continue;
    }
    if (STOPWORDS.has(canonical) || canonical.length < config.minTermLength) {
      if (!dropped.includes(canonical)) {
        dropped.push(canonical);
      }
      continue;
    }
    kept.push(token);
  }
  return { kept, dropped };
}

/** Thesaurus entries reachable from any spelling of one term. */
function synonymsFor(forms) {
  const found = new Map();
  for (const form of forms) {
    for (const synonym of THESAURUS[form] ?? []) {
      if (!found.has(synonym)) {
        found.set(synonym, true);
      }
    }
    for (const key of REVERSE_THESAURUS[form] ?? []) {
      if (!found.has(key)) {
        found.set(key, true);
      }
      for (const synonym of THESAURUS[key] ?? []) {
        if (!found.has(synonym)) {
          found.set(synonym, true);
        }
      }
    }
  }
  for (const form of forms) {
    found.delete(form);
  }
  return [...found.keys()];
}

function allForms(term) {
  return [term.text, ...term.variants];
}

function expandWithThesaurus(terms, seen, config) {
  const added = [];
  for (const term of [...terms]) {
    for (const synonym of synonymsFor(allForms(term))) {
      if (seen.has(synonym)) {
        continue;
      }
      const expanded = buildTerm(synonym, {
        kind: "keyword",
        origin: "thesaurus",
        maxVariants: config.maxVariantsPerTerm,
        derivedFrom: term.display,
      });
      if (!expanded) {
        continue;
      }
      seen.add(expanded.text);
      added.push(expanded);
    }
  }
  return added;
}

/**
 * Derive the search terms a prompt produces.
 *
 * @param {string} rawQuery the user's research prompt
 * @param {object} [settings] retrieval settings; defaults mirror the backend
 * @returns {{rawQuery: string, terms: PreviewTerm[], phrases: PreviewTerm[],
 *            stopwordsRemoved: string[], hasTerms: boolean}}
 */
export function previewQuery(rawQuery, settings = {}) {
  const config = { ...RETRIEVAL_DEFAULTS, ...settings };
  const raw = rawQuery ?? "";

  const phraseSources = [...raw.matchAll(PHRASE_RE)].map((match) => match[1]);
  const remainder = raw.replace(PHRASE_RE, " ");
  const { kept: wordSources, dropped } = selectWords(remainder, config);

  const phrases = [];
  const seenPhrases = new Set();
  for (const source of phraseSources) {
    const term = buildTerm(source.trim(), {
      kind: "phrase",
      origin: "query",
      maxVariants: config.maxVariantsPerTerm,
    });
    if (term && !seenPhrases.has(term.text)) {
      seenPhrases.add(term.text);
      phrases.push(term);
    }
  }

  const terms = [];
  const seenTerms = new Set();
  for (const source of wordSources) {
    const term = buildTerm(source, {
      kind: "keyword",
      origin: "query",
      maxVariants: config.maxVariantsPerTerm,
    });
    if (term && !seenTerms.has(term.text)) {
      seenTerms.add(term.text);
      terms.push(term);
    }
  }

  if (config.useThesaurus) {
    terms.push(...expandWithThesaurus(terms, seenTerms, config));
  }

  return {
    rawQuery: raw,
    terms,
    phrases,
    stopwordsRemoved: dropped,
    hasTerms: terms.length > 0 || phrases.length > 0,
  };
}

/** Terms the user actually wrote, as opposed to generated synonyms. */
export function directTerms(preview) {
  return preview.terms.filter((term) => term.origin === "query");
}

/** Synonyms the thesaurus added. */
export function thesaurusTerms(preview) {
  return preview.terms.filter((term) => term.origin === "thesaurus");
}

/** Every generated spelling across all terms, de-duplicated and sorted. */
export function generatedVariants(preview) {
  const forms = new Set();
  for (const term of [...preview.terms, ...preview.phrases]) {
    for (const variant of term.variants) {
      forms.add(variant);
    }
  }
  return [...forms].sort();
}
