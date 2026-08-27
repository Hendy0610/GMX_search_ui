// The GitHub client: which requests it makes, and what it refuses to leak.

import assert from "node:assert/strict";
import { test } from "node:test";

import { GitHubClient, GitHubError } from "../src/github.js";

// Deliberately not PAT-shaped. The tests only need a string that could not
// occur by accident; a realistic-looking token in a public repository is
// noise for every credential scanner that ever looks at it.
const TOKEN = "TEST-TOKEN-not-a-real-credential-9f3a2b";
const CONFIG = {
  owner: "owner",
  repo: "repo",
  workflow: "research.yml",
  ref: "main",
  resultsBranch: "research-results",
  apiBase: "https://api.github.test",
};

/** Records every request and replays queued responses. */
function fakeFetch(routes, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    for (const [pattern, response] of routes) {
      if (url.includes(pattern)) {
        return typeof response === "function" ? response() : response;
      }
    }
    return jsonResponse(404, { message: "Not Found" });
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function client(routes, calls = []) {
  return {
    client: new GitHubClient(CONFIG, TOKEN, fakeFetch(routes, calls)),
    calls,
  };
}

// --- the token --------------------------------------------------------------

test("the token travels only in the Authorization header", async () => {
  const { client: api, calls } = client([["/repos/owner/repo", jsonResponse(200, {})]]);
  await api.validateRepository();

  for (const call of calls) {
    assert.equal(call.url.includes(TOKEN), false, "token must never be in a URL");
    assert.equal(String(call.init.body ?? "").includes(TOKEN), false);
    assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
  }
});

test("disconnect makes the client unusable", async () => {
  const { client: api } = client([["/repos/owner/repo", jsonResponse(200, {})]]);
  api.disconnect();
  await assert.rejects(() => api.validateRepository(), /Keine Verbindung/);
});

test("no error message quotes the token", async () => {
  for (const status of [401, 403, 404, 422, 429, 500]) {
    const { client: api } = client([["/repos/owner/repo", jsonResponse(status, { m: TOKEN })]]);
    await assert.rejects(
      () => api.validateRepository(),
      (error) => {
        const rendered = `${error.message} ${error.stack ?? ""}`;
        assert.equal(rendered.includes(TOKEN), false);
        return true;
      },
    );
  }
});

test("a network failure does not surface the original error", async () => {
  const api = new GitHubClient(CONFIG, TOKEN, async () => {
    throw new Error(`connect failed for https://x/?token=${TOKEN}`);
  });
  await assert.rejects(
    () => api.validateRepository(),
    (error) => {
      assert.equal(error.message.includes(TOKEN), false);
      assert.equal(error.kind, "network");
      return true;
    },
  );
});

// --- error classification ---------------------------------------------------

test("each failure gets an actionable message", async () => {
  const cases = [
    [401, "auth", /Zugriffstoken/],
    [403, "forbidden", /Berechtigung|Anfragen/],
    [404, "not_found", /Repository/],
    [422, "invalid", /ungültig|Branch/],
    [429, "rate_limit", /Anfragen/],
  ];
  for (const [status, kind, pattern] of cases) {
    const { client: api } = client([["/repos/owner/repo", jsonResponse(status, {})]]);
    await assert.rejects(
      () => api.validateRepository(),
      (error) => {
        assert.equal(error.kind, kind, `status ${status}`);
        assert.match(error.message, pattern);
        return true;
      },
    );
  }
});

// --- dispatch ---------------------------------------------------------------

test("dispatch sends exactly the three declared inputs", async () => {
  const { client: api, calls } = client([["/dispatches", jsonResponse(204, null)]]);
  await api.dispatchResearch({
    researchId: "r-20260514-abcd1234",
    publicKeyB64: "BASE64KEY",
    payload: { schema: "gmx-research-request/1", query: "Verzug" },
    ref: "main",
  });

  const body = JSON.parse(calls.at(-1).init.body);
  assert.equal(body.ref, "main");
  assert.deepEqual(Object.keys(body.inputs).sort(), [
    "payload",
    "recipient_public_key",
    "research_id",
  ]);
  assert.equal(body.inputs.research_id, "r-20260514-abcd1234");
  assert.equal(JSON.parse(body.inputs.payload).query, "Verzug");
});

test("dispatch uses the workflow file from the configuration", async () => {
  const { client: api, calls } = client([["/dispatches", jsonResponse(204, null)]]);
  await api.dispatchResearch({ researchId: "r-1", publicKeyB64: "k", payload: {} });
  assert.ok(calls.at(-1).url.includes("/actions/workflows/research.yml/dispatches"));
  assert.equal(calls.at(-1).init.method, "POST");
});

// --- finding and following the run -----------------------------------------

test("the run is found by the research id in its name", async () => {
  const { client: api } = client([
    [
      "/actions/runs",
      jsonResponse(200, {
        workflow_runs: [
          { id: 1, display_title: "Research r-99999999-zzzzzzzz", status: "completed" },
          { id: 2, display_title: "Research r-20260514-abcd1234", status: "in_progress" },
        ],
      }),
    ],
  ]);
  const run = await api.findRun("r-20260514-abcd1234");
  assert.equal(run.id, 2);
  assert.equal(run.status, "in_progress");
});

test("no matching run yet is not an error", async () => {
  const { client: api } = client([["/actions/runs", jsonResponse(200, { workflow_runs: [] })]]);
  assert.equal(await api.findRun("r-20260514-abcd1234"), null);
});

test("a run is described by status and conclusion", async () => {
  const { client: api } = client([
    [
      "/actions/runs/7",
      jsonResponse(200, { id: 7, status: "completed", conclusion: "success", html_url: "u" }),
    ],
  ]);
  const run = await api.getWorkflowRun(7);
  assert.deepEqual(
    { id: run.id, status: run.status, conclusion: run.conclusion },
    { id: 7, status: "completed", conclusion: "success" },
  );
});

// --- fetching the envelope --------------------------------------------------

const ENVELOPE = { schema_version: "gmx-research-envelope/1", ciphertext: "Y2lwaGVy" };

function contentsResponse(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
  return jsonResponse(200, { content: encoded, encoding: "base64" });
}

test("the envelope is read from the results branch", async () => {
  const { client: api, calls } = client([["/contents/", contentsResponse(ENVELOPE)]]);
  const envelope = await api.getResultEnvelope("r-20260514-abcd1234");
  assert.deepEqual(envelope, ENVELOPE);
  assert.ok(calls.at(-1).url.includes("ref=research-results"));
  assert.ok(calls.at(-1).url.includes("r-20260514-abcd1234.result.json"));
});

test("a missing envelope reads as 'not there yet', not as an error", async () => {
  const { client: api } = client([["/contents/", jsonResponse(404, {})]]);
  assert.equal(await api.getResultEnvelope("r-20260514-abcd1234"), null);
});

test("a base64 payload split across lines still decodes", async () => {
  const encoded = Buffer.from(JSON.stringify(ENVELOPE), "utf-8").toString("base64");
  const wrapped = encoded.replace(/(.{20})/g, "$1\n");
  const { client: api } = client([
    ["/contents/", jsonResponse(200, { content: wrapped, encoding: "base64" })],
  ]);
  assert.deepEqual(await api.getResultEnvelope("r-1"), ENVELOPE);
});

test("an unreadable envelope is reported, not returned half-parsed", async () => {
  const { client: api } = client([
    ["/contents/", jsonResponse(200, { content: Buffer.from("{oops").toString("base64") })],
  ]);
  await assert.rejects(() => api.getResultEnvelope("r-1"), /JSON/);
});

test("an empty envelope file is an error", async () => {
  const { client: api } = client([["/contents/", jsonResponse(200, { content: "" })]]);
  await assert.rejects(() => api.getResultEnvelope("r-1"), /leer/);
});

test("only the four documented endpoints are ever called", async () => {
  const calls = [];
  const api = new GitHubClient(
    CONFIG,
    TOKEN,
    fakeFetch(
      [
        ["/repos/owner/repo/actions/runs", jsonResponse(200, { workflow_runs: [] })],
        ["/dispatches", jsonResponse(204, null)],
        ["/contents/", contentsResponse(ENVELOPE)],
        ["/repos/owner/repo", jsonResponse(200, {})],
      ],
      calls,
    ),
  );
  await api.validateRepository();
  await api.dispatchResearch({ researchId: "r-1", publicKeyB64: "k", payload: {} });
  await api.findRun("r-1");
  await api.getResultEnvelope("r-1");

  const allowed = [
    /\/repos\/owner\/repo$/,
    /\/repos\/owner\/repo\/actions\/workflows\/[^/]+\/dispatches$/,
    /\/repos\/owner\/repo\/actions\/runs(\?|$)/,
    /\/repos\/owner\/repo\/contents\/[^?]+(\?|$)/,
  ];
  for (const call of calls) {
    const path = call.url.replace(CONFIG.apiBase, "");
    assert.ok(
      allowed.some((pattern) => pattern.test(path)),
      `unexpected endpoint: ${path}`,
    );
  }
});

test("the client never issues a write to repository contents", async () => {
  const calls = [];
  const api = new GitHubClient(
    CONFIG,
    TOKEN,
    fakeFetch([["/contents/", contentsResponse(ENVELOPE)]], calls),
  );
  await api.getResultEnvelope("r-1");
  for (const call of calls) {
    if (call.url.includes("/contents/")) {
      assert.equal(call.init.method, "GET");
    }
  }
});

test("GitHubError carries a status a caller can branch on", () => {
  const error = new GitHubError("nope", { status: 404, kind: "not_found" });
  assert.equal(error.status, 404);
  assert.equal(error.kind, "not_found");
});
