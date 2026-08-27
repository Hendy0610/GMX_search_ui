// Turning result data into DOM, safely.
//
// Every string rendered here comes from a mailbox: subjects, sender addresses,
// attachment file names, quoted snippets. A mailbox in a legal dispute is
// exactly the place where a hostile string arrives, and it would arrive
// already decrypted and already trusted by the time it reaches this file.
//
// So there is one rule, and it is structural rather than careful: **text is set
// with textContent, never with innerHTML**. A `<script>` tag in a subject line
// becomes visible characters, because that is what textContent does with them.
// tests/dom.test.mjs asserts no module under src/ contains innerHTML,
// outerHTML, insertAdjacentHTML, document.write, eval or new Function, so the
// rule cannot be broken quietly in a later edit.
//
// The wording rules from the specification are enforced here too: a score is an
// "algorithmische Übereinstimmung", never a legal assessment. See BAND_LABELS.

/** Score bands, matching the backend thresholds in app/config.py. */
export const BAND_HIGH = 70;
export const BAND_MEDIUM = 40;

/**
 * The only words used to describe a score.
 *
 * Deliberately not "relevant", "beweiskräftig", "wahrscheinlich" or anything
 * else that sounds like a legal judgement. A reader has to be able to take this
 * label at face value, and the only thing the number actually measures is
 * agreement with the search rules.
 */
export const BAND_LABELS = {
  high: "Hohe algorithmische Übereinstimmung",
  medium: "Mittlere algorithmische Übereinstimmung",
  low: "Geringe algorithmische Übereinstimmung",
};

export function bandFor(score) {
  if (score >= BAND_HIGH) {
    return "high";
  }
  if (score >= BAND_MEDIUM) {
    return "medium";
  }
  return "low";
}

/** Source labels, in the reader's language. */
const SOURCE_LABELS = {
  subject: "Betreff",
  sender: "Absender",
  recipients: "Empfänger",
  email: "Mailtext",
  filename: "Dateiname",
  pdf: "PDF-Anhang",
};

export function sourceLabel(source) {
  return SOURCE_LABELS[source] ?? "Mailtext";
}

/** ISO timestamp to something a German reader expects. Never throws. */
export function formatDate(value) {
  if (!value) {
    return "ohne Datum";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "ohne Datum";
  }
  return parsed.toLocaleDateString("de-DE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Create an element with text content.
 *
 * The single constructor used by everything below, so there is exactly one
 * place where untrusted text meets the DOM - and it uses textContent.
 */
export function el(doc, tag, { className, text, attrs } = {}) {
  const node = doc.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined && text !== null) {
    node.textContent = String(text);
  }
  for (const [name, value] of Object.entries(attrs ?? {})) {
    node.setAttribute(name, String(value));
  }
  return node;
}

function labelledValue(doc, label, value) {
  const row = el(doc, "div", { className: "kv" });
  row.appendChild(el(doc, "span", { className: "kv-label", text: label }));
  row.appendChild(el(doc, "span", { className: "kv-value", text: value }));
  return row;
}

// -- the run summary --------------------------------------------------------

/**
 * Sentences describing the outcome, without overstating it.
 *
 * "Kandidaten gefunden" and "Treffer angezeigt" are different numbers and are
 * reported as such: the second is a statement about this list, never about the
 * mailbox.
 */
export function summaryLines(result) {
  const stats = result?.statistics ?? {};
  const lines = [
    `${stats.candidates ?? 0} Kandidaten gefunden`,
    `${stats.scored ?? 0} Nachrichten bewertet`,
    `${(result?.hits ?? []).length} Treffer angezeigt`,
  ];
  if (typeof stats.messages_examined === "number") {
    lines.push(`${stats.messages_examined} Nachrichten gelesen`);
  }
  return lines;
}

/** Why a result list is shorter than what was found, if it is. */
export function truncationNotice(result) {
  if (!result?.statistics?.truncated) {
    return null;
  }
  const reason = result.statistics.truncation_reason;
  return {
    title: "Es werden nur die bestbewerteten Treffer angezeigt.",
    detail: reason
      ? `Weitere Kandidaten wurden gefunden (${reason}).`
      : "Weitere Kandidaten wurden gefunden.",
  };
}

/** The partial-run notice, with the counters that explain it. */
export function partialNotice(result) {
  if (result?.status !== "partial") {
    return null;
  }
  const stats = result.statistics ?? {};
  const details = [];
  if (stats.messages_skipped) {
    details.push(`${stats.messages_skipped} Nachrichten konnten nicht gelesen werden`);
  }
  if (stats.pdfs_failed) {
    details.push(`${stats.pdfs_failed} PDF-Anhänge konnten nicht ausgewertet werden`);
  }
  if (stats.pdfs_without_text) {
    details.push(`${stats.pdfs_without_text} PDF-Anhänge enthielten keinen lesbaren Text`);
  }
  if (stats.warnings) {
    details.push(`${stats.warnings} Warnungen`);
  }
  if (stats.errors) {
    details.push(`${stats.errors} Fehler`);
  }
  return {
    title: "Recherche teilweise abgeschlossen",
    text:
      "Ein Teil der Nachrichten konnte nicht verarbeitet werden. Die angezeigten " +
      "Ergebnisse können deshalb unvollständig sein.",
    details,
  };
}

export function renderSummary(doc, result) {
  const box = el(doc, "section", { className: "summary" });
  const heading =
    result.status === "partial"
      ? "Recherche teilweise abgeschlossen"
      : "Recherche abgeschlossen";
  box.appendChild(el(doc, "h2", { text: heading }));

  const list = el(doc, "ul", { className: "summary-counts" });
  for (const line of summaryLines(result)) {
    list.appendChild(el(doc, "li", { text: line }));
  }
  box.appendChild(list);

  const partial = partialNotice(result);
  if (partial) {
    const notice = el(doc, "div", { className: "notice notice-warning" });
    notice.appendChild(el(doc, "p", { text: partial.text }));
    if (partial.details.length) {
      const details = el(doc, "ul");
      for (const detail of partial.details) {
        details.appendChild(el(doc, "li", { text: detail }));
      }
      notice.appendChild(details);
    }
    box.appendChild(notice);
  }

  const truncated = truncationNotice(result);
  if (truncated) {
    const notice = el(doc, "div", { className: "notice notice-info" });
    notice.appendChild(el(doc, "p", { text: truncated.title }));
    notice.appendChild(el(doc, "p", { text: truncated.detail }));
    box.appendChild(notice);
  }

  box.appendChild(
    el(doc, "p", {
      className: "disclaimer",
      text:
        "Die Ergebnisse sind eine algorithmische Übereinstimmung mit Ihren " +
        "Suchbegriffen und keine rechtliche Bewertung.",
    }),
  );
  return box;
}

// -- one hit ----------------------------------------------------------------

export function renderHit(doc, hit, index) {
  const card = el(doc, "article", { className: "hit", attrs: { "data-index": index } });

  const header = el(doc, "header", { className: "hit-header" });
  const band = bandFor(hit.relevance_score ?? 0);
  header.appendChild(
    el(doc, "span", {
      className: `score score-${band}`,
      text: `${hit.relevance_score ?? 0} / 100`,
    }),
  );
  header.appendChild(el(doc, "span", { className: "band", text: BAND_LABELS[band] }));
  card.appendChild(header);

  card.appendChild(el(doc, "h3", { className: "hit-subject", text: hit.subject || "(ohne Betreff)" }));
  card.appendChild(labelledValue(doc, "Datum", formatDate(hit.date)));
  card.appendChild(labelledValue(doc, "Absender", hit.sender || "(unbekannt)"));

  const reasons = Array.isArray(hit.reasons) ? hit.reasons : [];
  if (reasons.length) {
    card.appendChild(el(doc, "h4", { text: "Warum gefunden?" }));
    const list = el(doc, "ul", { className: "reasons" });
    for (const reason of reasons) {
      list.appendChild(el(doc, "li", { text: reason }));
    }
    card.appendChild(list);
  }

  const evidence = Array.isArray(hit.evidence) ? hit.evidence : [];
  if (evidence.length) {
    card.appendChild(el(doc, "h4", { text: "Trefferstellen" }));
    const list = el(doc, "ul", { className: "evidence" });
    for (const item of evidence) {
      const entry = el(doc, "li");
      entry.appendChild(
        el(doc, "span", { className: "evidence-source", text: sourceLabel(item.source) }),
      );
      // A snippet is mail text. textContent, always.
      entry.appendChild(el(doc, "blockquote", { text: item.snippet ?? "" }));
      if (item.location) {
        entry.appendChild(el(doc, "span", { className: "evidence-where", text: item.location }));
      }
      list.appendChild(entry);
    }
    card.appendChild(list);
  }

  const attachments = Array.isArray(hit.attachment_names) ? hit.attachment_names : [];
  if (attachments.length) {
    const line = el(doc, "p", { className: "attachments" });
    line.appendChild(el(doc, "span", { text: hit.pdf_relevant ? "PDF-Treffer: " : "Anhänge: " }));
    // File names are attacker-controlled too.
    line.appendChild(el(doc, "span", { text: attachments.join(", ") }));
    card.appendChild(line);
  }

  card.appendChild(renderHitDetails(doc, hit));
  return card;
}

/** The collapsed detail view. Same escaping rules throughout. */
export function renderHitDetails(doc, hit) {
  const details = el(doc, "details", { className: "hit-details" });
  details.appendChild(el(doc, "summary", { text: "Details anzeigen" }));

  const body = el(doc, "div", { className: "hit-details-body" });
  body.appendChild(labelledValue(doc, "Betreff", hit.subject || "(ohne Betreff)"));
  body.appendChild(labelledValue(doc, "Absender", hit.sender || "(unbekannt)"));
  body.appendChild(
    labelledValue(doc, "Empfänger", (hit.recipients ?? []).join(", ") || "(keine)"),
  );
  body.appendChild(labelledValue(doc, "Datum", formatDate(hit.date)));
  body.appendChild(labelledValue(doc, "Ordner", hit.folder ?? ""));
  body.appendChild(labelledValue(doc, "Message-ID", hit.message_id ?? "(fehlt)"));
  body.appendChild(labelledValue(doc, "UID", String(hit.message_uid ?? "")));

  const breakdown = Array.isArray(hit.reason_details) ? hit.reason_details : [];
  if (breakdown.length) {
    body.appendChild(el(doc, "h5", { text: "Wie der Score zustande kommt" }));
    const table = el(doc, "table", { className: "breakdown" });
    const head = el(doc, "tr");
    for (const column of ["Beitrag", "Quelle", "Punkte", "Begriffe"]) {
      head.appendChild(el(doc, "th", { text: column }));
    }
    table.appendChild(head);
    for (const reason of breakdown) {
      const row = el(doc, "tr");
      row.appendChild(el(doc, "td", { text: reason.description ?? reason.code ?? "" }));
      row.appendChild(el(doc, "td", { text: sourceLabel(reason.source) }));
      row.appendChild(el(doc, "td", { text: formatWeight(reason.weight) }));
      row.appendChild(el(doc, "td", { text: (reason.matched_terms ?? []).join(", ") }));
      table.appendChild(row);
    }
    body.appendChild(table);
  }

  const warnings = Array.isArray(hit.warnings) ? hit.warnings : [];
  if (warnings.length) {
    body.appendChild(el(doc, "h5", { text: "Hinweise zur Verarbeitung" }));
    const list = el(doc, "ul", { className: "warnings" });
    for (const warning of warnings) {
      list.appendChild(el(doc, "li", { text: warning }));
    }
    body.appendChild(list);
  }

  details.appendChild(body);
  return details;
}

export function formatWeight(weight) {
  const value = Number(weight ?? 0);
  if (!Number.isFinite(value)) {
    return "0";
  }
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

// -- the empty case ---------------------------------------------------------

/**
 * What "no hits" actually means.
 *
 * Not "there is nothing" - the deterministic search only ever reports what its
 * own words found. R-12 is at its most misleading exactly here, where an empty
 * list looks like an answer.
 */
export function renderEmpty(doc) {
  const box = el(doc, "section", { className: "empty" });
  box.appendChild(el(doc, "h2", { text: "Keine Kandidaten gefunden." }));
  box.appendChild(
    el(doc, "p", {
      text:
        "Das bedeutet nicht zwingend, dass keine relevante Kommunikation vorhanden " +
        "ist. Die Recherche arbeitet deterministisch anhand der verwendeten " +
        "Suchbegriffe: Eine Nachricht, die denselben Sachverhalt mit anderen Worten " +
        "beschreibt, wird nicht gefunden.",
    }),
  );
  box.appendChild(
    el(doc, "p", {
      text:
        "Versuchen Sie es mit anderen Formulierungen, weiteren Begriffen oder einem " +
        "größeren Zeitraum.",
    }),
  );
  return box;
}

export function renderResults(doc, result) {
  const container = el(doc, "div", { className: "results" });
  container.appendChild(renderSummary(doc, result));

  const hits = Array.isArray(result.hits) ? result.hits : [];
  if (!hits.length) {
    container.appendChild(renderEmpty(doc));
    return container;
  }
  const list = el(doc, "div", { className: "hit-list" });
  hits.forEach((hit, index) => list.appendChild(renderHit(doc, hit, index)));
  container.appendChild(list);
  return container;
}

// -- the search-scope preview ----------------------------------------------

/**
 * Show what the run will search for, before it runs.
 *
 * This is the R-12 disclosure in its most useful form: not a warning the reader
 * skips, but the actual list of words, with the generated spellings and the
 * synonyms named as such.
 */
export function renderQueryPreview(doc, preview) {
  const box = el(doc, "section", { className: "preview" });
  box.appendChild(el(doc, "h3", { text: "Daraus werden folgende Suchbegriffe verwendet" }));

  const direct = preview.terms.filter((term) => term.origin === "query");
  const synonyms = preview.terms.filter((term) => term.origin === "thesaurus");

  if (preview.phrases.length) {
    box.appendChild(termGroup(doc, "Phrasen (exakt gesucht)", preview.phrases.map((t) => t.display)));
  }
  box.appendChild(
    termGroup(doc, "Direkte Begriffe", direct.map((term) => term.display)),
  );

  const variants = new Set();
  for (const term of [...preview.terms, ...preview.phrases]) {
    for (const variant of term.variants) {
      variants.add(variant);
    }
  }
  if (variants.size) {
    box.appendChild(termGroup(doc, "Erzeugte Schreibvarianten", [...variants].sort()));
  }
  if (synonyms.length) {
    box.appendChild(
      termGroup(
        doc,
        "Verwandte Begriffe aus dem Fachwortschatz",
        synonyms.map((term) => `${term.display} (aus „${term.derivedFrom}“)`),
      ),
    );
  }
  if (preview.stopwordsRemoved.length) {
    box.appendChild(
      termGroup(doc, "Ignorierte Wörter", preview.stopwordsRemoved, "muted"),
    );
  }

  const note = el(doc, "p", { className: "notice notice-info" });
  note.textContent =
    "Die Recherche verwendet eine deterministische Wort- und Phrasensuche. " +
    "Bewertet werden nur Nachrichten, die anhand dieser Begriffe als Kandidaten " +
    "gefunden wurden. Inhaltlich ähnliche Formulierungen, die keines dieser " +
    "Wörter enthalten, können übersehen werden.";
  box.appendChild(note);
  return box;
}

function termGroup(doc, title, items, extraClass = "") {
  const group = el(doc, "div", { className: `term-group ${extraClass}`.trim() });
  group.appendChild(el(doc, "h4", { text: title }));
  if (!items.length) {
    group.appendChild(el(doc, "p", { className: "muted", text: "keine" }));
    return group;
  }
  const list = el(doc, "ul", { className: "term-list" });
  for (const item of items) {
    list.appendChild(el(doc, "li", { text: item }));
  }
  group.appendChild(list);
  return group;
}
