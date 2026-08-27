// Canonical search forms and German spelling variants.
//
// This is a hand port of app/services/text_normalizer.py. It exists so the
// browser can show, before a run starts, exactly which words the runner will
// search for - requirement R-12: a deterministic search must not be presented
// as if it understood meaning.
//
// A hand port is a duplicate, and duplicates drift. The guard is
// tests/test_query_preview_parity.py: it runs both implementations over a
// corpus of German and English prompts and fails the build on the first
// disagreement. Change one side without the other and CI stops you.
//
// Anything that is *data* rather than rule - the stopword list, the thesaurus -
// is generated instead of ported; see query-data.js.

/** Characters that expand to more than one ASCII character. */
const EXPANSIONS = new Map([
  ["ß", "ss"],
  ["ẞ", "ss"],
  ["æ", "ae"],
  ["Æ", "ae"],
  ["œ", "oe"],
  ["Œ", "oe"],
  ["ø", "o"],
  ["Ø", "o"],
  ["đ", "d"],
  ["ð", "d"],
  ["þ", "th"],
  ["ł", "l"],
]);

/** The German umlauts, with the two spellings that count as the same word. */
export const UMLAUT_PAIRS = [
  ["ä", "ae"],
  ["ö", "oe"],
  ["ü", "ue"],
];

/** Inflectional endings trimmed to reach a stem, longest first. */
const INFLECTIONS = ["en", "er", "es", "em", "e", "n", "s"];

/** A stem shorter than this matches far too much ("kosten" -> "kost"). */
const MIN_STEM_LENGTH = 5;

/** Word characters, matching Python's `[^\W_]+` under re.UNICODE. */
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

const COMBINING_RE = /\p{M}/gu;

/** Remove combining marks after decomposing. "ö" becomes "o". */
export function stripDiacritics(text) {
  return text.normalize("NFD").replace(COMBINING_RE, "");
}

/** Canonical form of a single character. May return zero or more characters. */
function foldChar(char) {
  const lowered = char.toLowerCase();
  const expanded = EXPANSIONS.get(lowered);
  if (expanded !== undefined) {
    return expanded;
  }
  const stripped = stripDiacritics(lowered);
  return stripped ? stripped : lowered;
}

/**
 * Canonical search form of a term: lower case, diacritics folded, whitespace
 * collapsed to single spaces, no leading or trailing space.
 */
export function normalizeTerm(term) {
  if (!term) {
    return "";
  }
  const display = term.normalize("NFC");
  const chars = [];
  let pendingSpace = false;

  for (const char of display) {
    if (/\s/u.test(char)) {
      // Collapse runs, and never start the search form with a space.
      pendingSpace = chars.length > 0;
      continue;
    }
    const folded = foldChar(char);
    if (!folded) {
      continue;
    }
    if (pendingSpace) {
      chars.push(" ");
      pendingSpace = false;
    }
    chars.push(folded);
  }
  return chars.join("");
}

/**
 * Spellings a German writer would consider the same word.
 *
 * Expansion: "Verzögerung" also searches "verzoegerung".
 * Contraction: "Verzoegerung" also searches "verzogerung", because the
 * canonical text form strips umlauts. Contraction is the generous half - it can
 * produce a spelling that means something else ("Poesie" also searches
 * "Posie"). That costs an extra candidate, never a missed one.
 */
export function umlautVariants(term) {
  const canonical = normalizeTerm(term);
  if (!canonical) {
    return [];
  }
  const forms = new Set([canonical]);

  let expanded = term.normalize("NFC").toLowerCase();
  for (const [umlaut, replacement] of UMLAUT_PAIRS) {
    expanded = expanded.split(umlaut).join(replacement);
  }
  expanded = normalizeTerm(expanded);
  if (expanded) {
    forms.add(expanded);
  }

  let contracted = canonical;
  for (const [umlaut, replacement] of UMLAUT_PAIRS) {
    contracted = contracted.split(replacement).join(stripDiacritics(umlaut));
  }
  if (contracted) {
    forms.add(contracted);
  }

  forms.delete(canonical);
  return [...forms];
}

/**
 * One conservatively trimmed form, if a safe one exists.
 *
 * Exactly one ending is removed - the longest that applies - and only when the
 * remainder is still at least MIN_STEM_LENGTH characters. "Termine" becomes
 * "termin"; "Kosten" is left alone rather than becoming "koste".
 */
export function stemVariants(term) {
  const canonical = normalizeTerm(term);
  if (!canonical || canonical.includes(" ")) {
    return [];
  }
  for (const ending of INFLECTIONS) {
    if (!canonical.endsWith(ending)) {
      continue;
    }
    // The longest applicable ending decides. Falling through to a shorter one
    // when its stem is too short would under-stem inconsistently.
    const stem = canonical.slice(0, canonical.length - ending.length);
    if (stem.length >= MIN_STEM_LENGTH && stem !== canonical) {
      return [stem];
    }
    return [];
  }
  return [];
}

/** Every generated spelling of a term: umlaut forms plus the stem. */
export function searchVariants(term) {
  const canonical = normalizeTerm(term);
  const forms = new Map();
  for (const variant of [...umlautVariants(term), ...stemVariants(term)]) {
    if (variant && variant !== canonical) {
      forms.set(variant, true);
    }
  }
  // A stem of a variant spelling, e.g. "verspaetete" -> "verspaetet".
  for (const variant of [...forms.keys()]) {
    for (const stem of stemVariants(variant)) {
      if (stem !== canonical) {
        forms.set(stem, true);
      }
    }
  }
  return [...forms.keys()];
}

/** Split text into word tokens, matching the Python tokenizer. */
export function tokenize(text) {
  return text.match(TOKEN_RE) ?? [];
}
