// Structural guards on the frontend source.
//
// The same idea as tests/test_imap_contract.py on the backend side: some
// properties are better enforced by parsing the source than by remembering
// them. A rendering path that reaches for innerHTML is a cross-site-scripting
// bug waiting for a hostile subject line, and it will not announce itself in a
// diff review six months from now.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const ROOT = join(HERE, "..");

function sourceFiles(dir = SRC) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith(".js")
        ? [join(dir, entry.name)]
        : [],
  );
}

function read(path) {
  return readFileSync(path, "utf-8");
}

/**
 * Source with comments removed.
 *
 * The guards below look for forbidden constructs as plain substrings, and the
 * files under test *document* those constructs - the header of render.js
 * explains why innerHTML is never used. Documentation is not code, and a guard
 * that cannot tell the difference trains people to weaken it. The backend
 * makes the same exemption for docstrings in tests/test_imap_contract.py.
 */
function code(path) {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Markup with HTML comments removed, for the same reason. */
function markup(path) {
  return read(path).replace(/<!--[\s\S]*?-->/g, " ");
}

/** Ways to turn a string into markup or into code. */
const FORBIDDEN = [
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "document.write",
  "eval(",
  "new Function(",
  "setAttribute('on",
  'setAttribute("on',
];

test("there are source files to check", () => {
  assert.ok(sourceFiles().length >= 5);
});

for (const path of sourceFiles()) {
  const name = path.slice(SRC.length + 1);

  test(`${name} never turns a string into markup or code`, () => {
    const source = code(path);
    for (const pattern of FORBIDDEN) {
      // The list is quoted in this test file, not in src/, so a plain
      // substring check is exact.
      assert.equal(
        source.includes(pattern),
        false,
        `${name} uses ${pattern}; mail content would become live markup`,
      );
    }
  });

  test(`${name} loads nothing from another origin`, () => {
    const source = code(path);
    assert.equal(/import\s+.*from\s+["']https?:/.test(source), false);
    assert.equal(/importScripts|<script/.test(source), false);
  });

  test(`${name} contains no credential-shaped literal`, () => {
    const source = read(path);
    for (const pattern of [/ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/]) {
      assert.equal(pattern.test(source), false, `${name} contains a token literal`);
    }
  });
}

test("no module writes a token to the console", () => {
  for (const path of sourceFiles()) {
    const source = code(path);
    // console.* is absent entirely: the simplest way to be sure nothing
    // sensitive is ever logged is to log nothing at all.
    assert.equal(
      /console\.(log|info|warn|error|debug)/.test(source),
      false,
      `${path} logs to the console`,
    );
  }
});

test("only the GitHub API host is contacted", () => {
  const hosts = new Set();
  for (const path of sourceFiles()) {
    for (const match of read(path).matchAll(/https?:\/\/([\w.-]+)/g)) {
      hosts.add(match[1]);
    }
  }
  for (const file of ["config.js", "index.html"]) {
    for (const match of read(join(ROOT, file)).matchAll(/https?:\/\/([\w.-]+)/g)) {
      hosts.add(match[1]);
    }
  }
  assert.deepEqual([...hosts].sort(), ["api.github.com"]);
});

// --- the page itself --------------------------------------------------------

test("the page declares a Content Security Policy", () => {
  const html = read(join(ROOT, "index.html"));
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src https:\/\/api\.github\.com/);
});

test("the policy allows no inline or remote code", () => {
  const html = markup(join(ROOT, "index.html"));
  assert.equal(html.includes("unsafe-inline"), false);
  assert.equal(html.includes("unsafe-eval"), false);
  assert.equal(/script-src[^;]*https?:/.test(html), false);
});

test("the page contains no inline script and no inline handler", () => {
  const html = markup(join(ROOT, "index.html"));
  // Every <script> must be a src= module reference, never a body of code.
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(match[1], /\ssrc=/, "a <script> without src is inline code");
    assert.equal(match[2].trim(), "", "a <script> tag contains code");
  }
  assert.equal(/\son(click|load|error|submit|input)=/i.test(html), false);
});

test("the token field is a password field", () => {
  const html = read(join(ROOT, "index.html"));
  assert.match(html, /<input\s+type="password"\s+id="token"/);
});

test("every form control has a label", () => {
  const html = read(join(ROOT, "index.html"));
  const ids = [...html.matchAll(/<(?:input|textarea|select)\b[^>]*\bid="([^"]+)"/g)].map(
    (match) => match[1],
  );
  const labelled = new Set(
    [...html.matchAll(/<label\s+for="([^"]+)"/g)].map((match) => match[1]),
  );
  assert.ok(ids.length >= 6);
  for (const id of ids) {
    assert.ok(labelled.has(id), `#${id} has no <label for>`);
  }
});

test("the configuration file holds no secret", () => {
  const config = code(join(ROOT, "config.js"));
  for (const pattern of [/token\s*:/i, /secret/i, /password/i, /privateKey/i]) {
    assert.equal(pattern.test(config), false, `config.js mentions ${pattern}`);
  }
});

test("no wording in the interface claims legal meaning", () => {
  // The one rule the specification is most emphatic about: a score describes
  // agreement with search rules, never legal relevance or evidential weight.
  const forbidden = [
    "juristisch relevant",
    "rechtlich relevant",
    "beweiskräftig",
    "rechtlich wichtig",
    "alle relevanten",
  ];
  const texts = [markup(join(ROOT, "index.html")), code(join(SRC, "render.js"))];
  for (const text of texts) {
    const lowered = text.toLowerCase();
    for (const phrase of forbidden) {
      assert.equal(lowered.includes(phrase), false, `found "${phrase}"`);
    }
  }
});
