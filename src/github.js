// The only place in this application that talks to GitHub.
//
// Scattering fetch() calls would scatter the token with them. Here the token
// exists as one private field, is written into exactly one header, and every
// error is rebuilt locally before it is allowed to reach a caller - GitHub's
// own error bodies can echo request details, and a rejected request must not
// turn into a stack trace with an Authorization header in it.
//
// Endpoints used, and the fine-grained PAT permission each one needs:
//
//   GET  /repos/{owner}/{repo}                       Metadata: read
//        confirms the token can see the repository at all, before anything else
//   POST /repos/{owner}/{repo}/actions/workflows/{f}/dispatches
//                                                    Actions: read and write
//        starts a research run
//   GET  /repos/{owner}/{repo}/actions/runs?...      Actions: read
//        finds the run belonging to a research id, and follows its status
//   GET  /repos/{owner}/{repo}/contents/{p}?ref={b}  Contents: read
//        fetches the encrypted envelope from the results branch
//
// Nothing here writes repository contents: the runner publishes with its own
// built-in token. Contents therefore stays read-only, which is the whole reason
// the PAT can be that narrow.

const API_VERSION = "2022-11-28";
const JSON_ACCEPT = "application/vnd.github+json";

export class GitHubError extends Error {
  constructor(message, { status = 0, kind = "request" } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.kind = kind;
  }
}

/**
 * Messages a non-technical reader can act on.
 *
 * German, because that is the language of the interface these reach. Never
 * GitHub's own response body: it can quote the request, and a request carries
 * an Authorization header.
 */
function describeStatus(status, what) {
  switch (status) {
    case 401:
      return {
        kind: "auth",
        message:
          "GitHub hat den Zugriffstoken abgelehnt. Er kann falsch eingegeben, " +
          "abgelaufen oder widerrufen sein.",
      };
    case 403:
      return {
        kind: "forbidden",
        message:
          "GitHub hat die Anfrage abgelehnt. Dem Token fehlt vermutlich eine " +
          "Berechtigung, oder es wurden zu viele Anfragen gestellt - in dem Fall " +
          "bitte einige Minuten warten.",
      };
    case 404:
      return {
        kind: "not_found",
        message:
          `Nicht gefunden: ${what}. Bitte prüfen Sie den Repository-Namen und ob ` +
          "der Token Zugriff auf dieses Repository hat.",
      };
    case 422:
      return {
        kind: "invalid",
        message:
          "GitHub hat die Anfrage als ungültig zurückgewiesen. Möglicherweise gibt " +
          "es die Workflow-Datei oder den Branch dort nicht.",
      };
    case 429:
      return {
        kind: "rate_limit",
        message:
          "Zu viele Anfragen an GitHub. Bitte einige Minuten warten und es erneut " +
          "versuchen.",
      };
    default:
      return {
        kind: "request",
        message: `GitHub hat unerwartet mit Status ${status} geantwortet (${what}).`,
      };
  }
}


export class GitHubClient {
  #token;
  #config;
  #fetch;

  /**
   * @param {object} config owner, repo, workflow, resultsBranch, apiBase
   * @param {string} token fine-grained PAT; held in memory only
   * @param {typeof fetch} [fetchImpl] injected in tests
   */
  constructor(config, token, fetchImpl = globalThis.fetch) {
    this.#config = config;
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  /** Forget the token. After this the client cannot make an authorised call. */
  disconnect() {
    this.#token = "";
  }

  get repositoryPath() {
    return `${this.#config.owner}/${this.#config.repo}`;
  }

  #url(path, params) {
    const base = this.#config.apiBase.replace(/\/+$/, "");
    const url = new URL(`${base}/repos/${this.repositoryPath}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async #request(method, path, { params, body, what } = {}) {
    if (!this.#token) {
      throw new GitHubError("Keine Verbindung zu GitHub.", { kind: "auth" });
    }
    let response;
    try {
      response = await this.#fetch(this.#url(path, params), {
        method,
        headers: {
          // The one and only place the token appears. Never a query parameter:
          // URLs end up in history, in referrers, and in error messages.
          Authorization: `Bearer ${this.#token}`,
          Accept: JSON_ACCEPT,
          "X-GitHub-Api-Version": API_VERSION,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      // The original error can carry the request object. It is dropped.
      throw new GitHubError(
        "GitHub konnte nicht erreicht werden. Bitte prüfen Sie Ihre Internetverbindung.",
        { kind: "network" },
      );
    }

    if (response.status === 204) {
      return null;
    }
    if (!response.ok) {
      const { kind, message } = describeStatus(response.status, what ?? "die Anfrage");
      throw new GitHubError(message, { status: response.status, kind });
    }
    try {
      return await response.json();
    } catch {
      throw new GitHubError("GitHub hat eine Antwort geliefert, die nicht gelesen werden konnte.", {
        status: response.status,
      });
    }
  }

  /**
   * Confirm the token can see the repository.
   *
   * Uses the plain repository endpoint rather than a permissions probe: it needs
   * only Metadata access, which every fine-grained token has, so a failure here
   * means the token or the repository name is wrong - not that a scope is
   * missing.
   */
  async validateRepository() {
    const data = await this.#request("GET", "", { what: "das Repository" });
    return {
      fullName: String(data?.full_name ?? this.repositoryPath),
      private: Boolean(data?.private),
      defaultBranch: String(data?.default_branch ?? ""),
    };
  }

  /**
   * Start a research run.
   *
   * The inputs are exactly the three the workflow declares. They are visible in
   * the run metadata to anyone with repository read access, which is why the
   * prompt is the only user text among them and why no credential is passed.
   */
  async dispatchResearch({ researchId, publicKeyB64, payload, ref }) {
    await this.#request(
      "POST",
      `/actions/workflows/${encodeURIComponent(this.#config.workflow)}/dispatches`,
      {
        what: "der Recherche-Workflow",
        body: {
          ref: ref ?? this.#config.ref,
          inputs: {
            research_id: researchId,
            recipient_public_key: publicKeyB64,
            payload: JSON.stringify(payload),
          },
        },
      },
    );
    return { researchId };
  }

  /**
   * Start a copy order.
   *
   * The same dispatch endpoint and the same permission as a research run - a
   * different workflow file. The inputs carry message *references* and a
   * folder name: no subject, no body, no snippet. Run metadata is visible to
   * everyone with repository read access.
   */
  async dispatchCopy({ researchId, publicKeyB64, payload, allowExisting = false, ref }) {
    await this.#request(
      "POST",
      `/actions/workflows/${encodeURIComponent(this.#config.copyWorkflow)}/dispatches`,
      {
        what: "der Kopier-Workflow",
        body: {
          ref: ref ?? this.#config.ref,
          inputs: {
            research_id: researchId,
            recipient_public_key: publicKeyB64,
            payload: JSON.stringify(payload),
            allow_existing_destination: allowExisting ? "true" : "false",
          },
        },
      },
    );
    return { researchId };
  }

  /**
   * Find the workflow run for a research id.
   *
   * GitHub's dispatch endpoint returns no run id, so the run has to be located
   * afterwards. Runs are listed newest first and matched by the research id in
   * their display title; until one appears the run is still being created.
   */
  async findRun(researchId, { createdAfter = null, namePrefix = null } = {}) {
    const data = await this.#request("GET", "/actions/runs", {
      what: "die Workflow-Läufe",
      params: {
        event: "workflow_dispatch",
        per_page: 20,
        ...(createdAfter ? { created: `>=${createdAfter}` } : {}),
      },
    });
    const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
    // The run name is "Research <id>" or "Copy <id>". Matching on the id alone
    // would pick up the research run when looking for the copy run, since both
    // carry the same id.
    const match = runs.find(
      (run) =>
        typeof run?.display_title === "string" &&
        run.display_title.includes(researchId) &&
        (!namePrefix || run.display_title.startsWith(namePrefix)),
    );
    return match ? this.#describeRun(match) : null;
  }

  async getWorkflowRun(runId) {
    const data = await this.#request("GET", `/actions/runs/${encodeURIComponent(runId)}`, {
      what: "der Workflow-Lauf",
    });
    return this.#describeRun(data);
  }

  #describeRun(run) {
    return {
      id: Number(run?.id ?? 0),
      status: String(run?.status ?? "unknown"),
      conclusion: run?.conclusion ? String(run.conclusion) : null,
      htmlUrl: typeof run?.html_url === "string" ? run.html_url : "",
      startedAt: run?.run_started_at ? String(run.run_started_at) : "",
    };
  }

  /**
   * Fetch the encrypted envelope from the results branch.
   *
   * The Contents API returns the file base64-encoded inside JSON, which is the
   * reason results travel this way rather than as a workflow artifact: artifact
   * downloads redirect to a host that sends no CORS headers, so a browser
   * cannot follow them.
   *
   * Returns null while the file does not exist yet - a run can finish moments
   * before its commit is visible.
   */
  async getResultEnvelope(researchId, { kind = "result" } = {}) {
    const path = `${researchId}.${kind}.json`;
    let data;
    try {
      data = await this.#request("GET", `/contents/${encodeURIComponent(path)}`, {
        what: "die Ergebnisdatei",
        params: { ref: this.#config.resultsBranch },
      });
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) {
        return null;
      }
      throw error;
    }
    const encoded = typeof data?.content === "string" ? data.content : "";
    if (!encoded) {
      throw new GitHubError("Die Ergebnisdatei war leer.", { kind: "invalid" });
    }
    let text;
    try {
      text = new TextDecoder().decode(
        Uint8Array.from(atob(encoded.replace(/\s+/g, "")), (char) => char.charCodeAt(0)),
      );
    } catch {
      throw new GitHubError("Die Ergebnisdatei konnte nicht gelesen werden.", { kind: "invalid" });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new GitHubError("Die Ergebnisdatei enthielt kein gültiges JSON.", { kind: "invalid" });
    }
  }
}
