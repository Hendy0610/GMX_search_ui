// Public configuration. Everything here is visible to anyone who opens the page.
//
// That is fine, and it is the reason this file exists separately: it makes the
// boundary obvious. A value belongs here only if publishing it costs nothing.
//
// NEVER put in this file - or anywhere else in this repository:
//   an access token, a private key, a GMX address, a password,
//   or a folder name from the mailbox.
//
// The token is typed by the operator at run time and lives in memory only.

export const CONFIG = {
  // The private backend repository the browser talks to.
  owner: "Hendy0610",
  repo: "GMX_search",

  // The workflow file that runs a research, and the branch it is dispatched on.
  workflow: "research.yml",
  ref: "claude/gmx-serverless-research-ipe51j",

  // Orphan branch carrying the encrypted result envelopes.
  resultsBranch: "research-results",

  apiBase: "https://api.github.com",
};
