import { seal } from "tweetnacl-sealedbox-js";

const API = "https://api.github.com";

export type GH = { token: string; login: string };

/** The dispatch-stage taxonomy the UI/DB use to distinguish *why* a build
 *  never reached workflow_dispatch (or failed at it) — "unknown" is a
 *  last-resort fallback, never the default for a case we can actually name. */
export type DispatchErrorCategory =
  | "github-auth"
  | "repository-access"
  | "contents-permission"
  | "workflow-permission"
  | "actions-permission"
  | "secrets-permission"
  | "workflow-upload"
  | "workflow-registration"
  | "workflow-dispatch"
  | "run-discovery"
  | "network"
  | "unknown";

/** Named phases of the dispatch handshake, surfaced via an optional callback
 *  so the caller can persist them (e.g. builds.stage) for real-time
 *  visibility — never inferred from vague log text. */
export type DispatchStage =
  | "WORKFLOW_FILE_UPLOADED"
  | "WORKFLOW_REGISTERING"
  | "WORKFLOW_REGISTERED"
  | "DISPATCHING"
  | "DISPATCH_ACCEPTED"
  | "DISPATCH_FAILED"
  | "RUN_DISCOVERY";

/** Carries a structured category alongside the human-readable message, so
 *  the build row can record *which stage* failed instead of a generic
 *  "dispatch" bucket for everything from a bad token to a 5xx from GitHub. */
export class GithubStageError extends Error {
  category: DispatchErrorCategory;
  constructor(message: string, category: DispatchErrorCategory) {
    super(message);
    this.name = "GithubStageError";
    this.category = category;
  }
}

/** Retry helper: only for transient network errors and 429/5xx. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  isTransient: (result: T) => boolean = () => false,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = await fn();
      if (i < attempts - 1 && isTransient(out)) {
        await new Promise((r) => setTimeout(r, 600 * 2 ** i));
        continue;
      }
      return out;
    } catch (e) {
      lastError = e;
      if (i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 600 * 2 ** i));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function transientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Maps explainGithubError's "what" plus an HTTP status to the dispatch-stage
 *  taxonomy above, so existing call sites can opt in without changing their
 *  message text. */
function categorize(
  status: number,
  what: "contents" | "workflow-file" | "secrets" | "actions" | "repo",
): DispatchErrorCategory {
  if (status === 401) return "github-auth";
  const byWhat: Record<typeof what, DispatchErrorCategory> = {
    contents: "contents-permission",
    "workflow-file": "workflow-permission",
    secrets: "secrets-permission",
    actions: "actions-permission",
    repo: "repository-access",
  };
  return byWhat[what];
}

/**
 * GitHub answers "Resource not accessible by personal access token" with a bare
 * 403 for any permission a fine-grained PAT is missing. Turn that into a
 * sentence that names the exact permission the user has to grant.
 */
export function explainGithubError(
  status: number,
  rawBody: unknown,
  what: "contents" | "workflow-file" | "secrets" | "actions" | "repo",
): string {
  const text = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody ?? "");
  const notAccessible = /not accessible by (personal access token|integration)/i.test(text);
  const needed: Record<typeof what, string> = {
    contents: "Contents: Read and write",
    "workflow-file": "Contents: Read and write **and** Workflows: Read and write",
    secrets: "Secrets: Read and write",
    actions: "Actions: Read and write",
    repo: "Administration: Read and write (to create the build repository)",
  } as const;
  if (status === 403 && notAccessible) {
    return `GitHub blocked this token (403). Your fine-grained personal access token is missing “${needed[what]}” on the APKForge build repository. Open GitHub → Settings → Developer settings → Personal access tokens → your token → Repository permissions, grant it (or select “All repositories”), save, then reconnect GitHub in Settings. A classic token with the \`repo\` + \`workflow\` scopes also works.`;
  }
  if (status === 403) {
    return `GitHub refused the request (403): ${text.slice(0, 300)}`;
  }
  if (status === 401) {
    return "GitHub says the stored token is invalid or expired (401). Reconnect GitHub in Settings with a fresh token.";
  }
  if (status === 404) {
    return `GitHub returned 404 for this repository. If the token is fine-grained, make sure the APKForge build repository is included in its “Repository access” list.`;
  }
  return `GitHub request failed (${status}): ${text.slice(0, 300)}`;
}

/**
 * Fails fast, before any build row is dispatched, when the token cannot write
 * to the build repo — so the user gets the permission fix instead of a raw 403
 * halfway through the pipeline.
 */
export async function assertRepoWritable(g: GH, repo: string): Promise<string> {
  const r = await gh<{ permissions?: { push?: boolean; admin?: boolean }; default_branch?: string }>(
    g,
    `/repos/${g.login}/${repo}`,
  );
  if (r.status >= 300) throw new GithubStageError(explainGithubError(r.status, r.body, "repo"), categorize(r.status, "repo"));
  if (r.body?.permissions && r.body.permissions.push !== true) {
    throw new GithubStageError(explainGithubError(403, "not accessible by personal access token", "contents"), categorize(403, "contents"));
  }
  const branch = r.body?.default_branch || "main";

  // Writing inside .github/workflows/ needs a permission that is separate from
  // plain Contents write. Probe it with a harmless marker file so the failure
  // surfaces before any build state is touched.
  const probePath = ".github/workflows/.apkforge-permission-probe";
  const encoded = encodeContentPath(probePath);
  const existing = await gh<{ sha?: string }>(
    g,
    `/repos/${g.login}/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
  );
  const body: Record<string, unknown> = {
    message: "APKForge: verify workflow write permission",
    content: btoa(`apkforge-probe ${new Date().toISOString()}\n`),
    branch,
  };
  if (existing.status === 200 && existing.body?.sha) body.sha = existing.body.sha;
  const probe = await gh(g, `/repos/${g.login}/${repo}/contents/${encoded}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (probe.status >= 300) {
    throw new GithubStageError(explainGithubError(probe.status, probe.body, "workflow-file"), categorize(probe.status, "workflow-file"));
  }
  return branch;
}

/** Every GitHub API call gets a hard timeout so a stalled connection can never
 *  hang a build indefinitely — it surfaces as a clear, retryable error instead. */
const GH_TIMEOUT_MS = 20_000;

async function gh<T = unknown>(
  { token }: GH,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T | null; res: Response }> {
  let res: Response;
  try {
    res = await fetch(API + path, {
      ...init,
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "APKForge",
        ...(init.headers ?? {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error(`GitHub API request timed out after ${GH_TIMEOUT_MS / 1000}s: ${path}`);
    }
    throw e;
  }
  let body: T | null = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = text as unknown as T;
    }
  }
  return { status: res.status, body, res };
}

/**
 * GitHub's Contents API takes a real path — each segment escaped, separators
 * left alone. Percent-encoding the slashes (encodeURIComponent on the whole
 * path) produces a URL GitHub can never resolve and answers 403/404 no matter
 * how well-scoped the token is.
 */
function encodeContentPath(path: string): string {
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

/** Login of the account the token belongs to (used to pick user vs org repo creation). */
async function authenticatedLogin(g: GH): Promise<string | null> {
  const r = await gh<{ login?: string }>(g, "/user");
  return r.status === 200 ? (r.body?.login ?? null) : null;
}

export async function ensureRepo(g: GH, repo: string): Promise<void> {
  const check = await gh(g, `/repos/${g.login}/${repo}`);
  if (check.status === 200) return;
  if (check.status !== 404) {
    throw new Error(
      `GitHub repo check failed (${check.status}): ${JSON.stringify(check.body).slice(0, 200)}`,
    );
  }
  // Personal accounts create under /user/repos; organizations need /orgs/{org}/repos.
  const me = await authenticatedLogin(g);
  const isOrg = !!me && me.toLowerCase() !== g.login.toLowerCase();
  const createPath = isOrg ? `/orgs/${g.login}/repos` : `/user/repos`;
  const create = await gh(g, createPath, {
    method: "POST",
    body: JSON.stringify({
      name: repo,
      private: true,
      auto_init: true,
      description: "APKForge Android build repo (managed)",
    }),
  });
  if (create.status >= 300) {
    throw new GithubStageError(explainGithubError(create.status, create.body, "repo"), categorize(create.status, "repo"));
  }
}

export async function upsertFileOnRepo(
  g: GH,
  owner: string,
  repo: string,
  path: string,
  contentUtf8: string,
  message: string,
  branch?: string,
): Promise<void> {
  const ref = branch || (await getDefaultBranch(g, owner, repo));
  const encoded = encodeContentPath(path);
  const existing = await gh<{ sha?: string }>(
    g,
    `/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
  );
  const body: Record<string, unknown> = {
    message,
    content: btoa(unescape(encodeURIComponent(contentUtf8))),
    branch: ref,
  };
  if (existing.status === 200 && existing.body?.sha) body.sha = existing.body.sha;
  const put = await gh(g, `/repos/${owner}/${repo}/contents/${encoded}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (put.status >= 300) {
    throw new GithubStageError(
      explainGithubError(
        put.status,
        put.body,
        path.startsWith(".github/workflows") ? "workflow-file" : "contents",
      ),
      categorize(put.status, path.startsWith(".github/workflows") ? "workflow-file" : "contents"),
    );
  }

}

export async function upsertFile(
  g: GH,
  repo: string,
  path: string,
  contentUtf8: string,
  message: string,
  branch?: string,
): Promise<void> {
  return upsertFileOnRepo(g, g.login, repo, path, contentUtf8, message, branch);
}

/**
 * Reads the just-uploaded workflow file back from GitHub and confirms it's
 * actually dispatchable — catches "upload succeeded but the file GitHub has
 * isn't what we think it is" (wrong branch, encoding mismatch, a stale
 * cached copy, or an input this code is about to send that the workflow
 * doesn't declare) before spending a dispatch attempt finding out the hard
 * way. Read-only; never mutates anything.
 */
/**
 * Non-throwing diagnostic counterpart to verifyWorkflowUpload — used only to
 * report exactly what GitHub currently serves when a dispatch fails
 * unexpectedly, never to gate normal flow.
 *
 * Uses the same rigorous, indentation-aware structural check as
 * validateAndroidWorkflowYaml (dynamically imported to avoid a circular
 * static import between these two files) rather than a plain substring
 * search — a loose "does 'workflow_dispatch:' appear anywhere after 'on:'"
 * regex can be genuinely fooled by the trigger existing in the file but
 * nested under the wrong key, which is exactly the class of bug this
 * diagnostic exists to catch, not paper over with a false "looks fine".
 * Also captures the literal `on:` block content (never the whole file) so a
 * human can see the real structure GitHub is serving, rather than trusting
 * a second layer of regex summary to be correct.
 */
async function inspectWorkflowFile(
  g: GH,
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<{ exists: boolean; sha?: string; containsWorkflowDispatch: boolean; onBlockSnippet?: string }> {
  const r = await gh<{ content?: string; sha?: string }>(
    g,
    `/repos/${owner}/${repo}/contents/${encodeContentPath(path)}?ref=${encodeURIComponent(branch)}`,
  );
  if (r.status !== 200 || !r.body?.content) {
    return { exists: false, containsWorkflowDispatch: false };
  }
  let yaml = "";
  try {
    yaml = decodeURIComponent(escape(atob(r.body.content.replace(/\n/g, ""))));
  } catch {
    return { exists: true, sha: r.body.sha, containsWorkflowDispatch: false };
  }
  const { validateAndroidWorkflowYaml } = await import("./android-workflow");
  const result = validateAndroidWorkflowYaml(yaml);

  // Extract just the on: block (from the on: line to the next top-level key
  // or EOF) for the diagnostic — bounded so a pathological file can't blow
  // up the error message or logs.
  const lines = yaml.split("\n");
  const onIdx = lines.findIndex((l) => /^on:\s*(#.*)?$/.test(l));
  let onBlockSnippet: string | undefined;
  if (onIdx !== -1) {
    const block: string[] = [lines[onIdx]];
    for (let i = onIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() !== "" && /^\S/.test(lines[i])) break; // next top-level key
      block.push(lines[i]);
      if (block.join("\n").length > 400) break;
    }
    onBlockSnippet = block.join("\n").slice(0, 400);
  }

  return {
    exists: true,
    sha: r.body.sha,
    containsWorkflowDispatch: result.valid,
    onBlockSnippet,
  };
}

export async function verifyWorkflowUpload(
  g: GH,
  repo: string,
  path: string,
  branch: string,
  requiredInputs: string[],
): Promise<void> {
  const owner = g.login;
  const r = await gh<{ content?: string; encoding?: string }>(
    g,
    `/repos/${owner}/${repo}/contents/${encodeContentPath(path)}?ref=${encodeURIComponent(branch)}`,
  );
  if (r.status !== 200 || !r.body?.content) {
    throw new GithubStageError(
      `Uploaded the Android workflow to ${owner}/${repo}@${branch}, but reading it back returned ${r.status}. GitHub may not have finished committing it yet — retrying the build should resolve this.`,
      "workflow-upload",
    );
  }
  let yaml: string;
  try {
    yaml = decodeURIComponent(escape(atob(r.body.content.replace(/\n/g, ""))));
  } catch {
    throw new GithubStageError(
      `The workflow file at ${owner}/${repo}@${branch}/${path} could not be decoded after upload — it may be corrupted.`,
      "workflow-upload",
    );
  }
  const { validateAndroidWorkflowYaml } = await import("./android-workflow");
  const structural = validateAndroidWorkflowYaml(yaml);
  if (!structural.valid) {
    throw new GithubStageError(
      `The uploaded workflow at ${owner}/${repo}@${branch}/${path} does not have a correctly-placed workflow_dispatch trigger — dispatch would fail. ${structural.error} This should not happen with APKForge's own generated workflow; if you see this, the upload was corrupted in transit or the live file has drifted from what was generated.`,
      "workflow-upload",
    );
  }
  const declared = await declaredInputs(g, owner, repo, path);
  const missing = declared ? requiredInputs.filter((i) => !declared.has(i)) : requiredInputs;
  if (missing.length) {
    throw new GithubStageError(
      `The uploaded workflow at ${owner}/${repo}@${branch}/${path} doesn't declare the input${missing.length > 1 ? "s" : ""} this build needs to send: ${missing.join(", ")}. The workflow file may be out of date on GitHub — retrying will re-upload the current version.`,
      "workflow-upload",
    );
  }
}

export async function putSecret(
  g: GH,
  repo: string,
  name: string,
  value: string,
): Promise<void> {
  const keyRes = await gh<{ key: string; key_id: string }>(
    g,
    `/repos/${g.login}/${repo}/actions/secrets/public-key`,
  );
  if (keyRes.status >= 300 || !keyRes.body) {
    throw new GithubStageError(explainGithubError(keyRes.status, keyRes.body, "secrets"), categorize(keyRes.status, "secrets"));
  }
  const publicKey = Uint8Array.from(atob(keyRes.body.key), (c) => c.charCodeAt(0));
  const messageBytes = new TextEncoder().encode(value);
  const encrypted = seal(messageBytes, publicKey);
  let bin = "";
  for (const b of encrypted) bin += String.fromCharCode(b);
  const encryptedValue = btoa(bin);
  const put = await gh(g, `/repos/${g.login}/${repo}/actions/secrets/${name}`, {
    method: "PUT",
    body: JSON.stringify({ encrypted_value: encryptedValue, key_id: keyRes.body.key_id }),
  });
  if (put.status >= 300) throw new GithubStageError(explainGithubError(put.status, put.body, "secrets"), categorize(put.status, "secrets"));

}

function bodyText(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return body.slice(0, 400);
  try {
    return JSON.stringify(body).slice(0, 400);
  } catch {
    return "";
  }
}

async function getDefaultBranch(g: GH, owner: string, repo: string): Promise<string> {
  const r = await gh<{ default_branch?: string }>(g, `/repos/${owner}/${repo}`);
  return r.body?.default_branch || "main";
}

/** Best-effort + explicit-failure split, deliberately: enabling Actions repo-
 *  wide requires Administration permission, which most fine-grained tokens
 *  intentionally don't have and genuinely don't need (repos created via the
 *  API already have Actions enabled) — that one stays best-effort. Enabling
 *  a specific *workflow* is different: a 403 there means the token can't
 *  actually operate on Actions for this repo at all, which will otherwise
 *  surface later as a confusing dispatch failure. That case is surfaced
 *  explicitly instead of swallowed, so the real cause reaches the user. */
async function ensureActionsEnabled(
  g: GH,
  owner: string,
  repo: string,
  workflowFilename: string,
): Promise<{ workflowEnablePermissionDenied: boolean }> {
  try {
    await gh(g, `/repos/${owner}/${repo}/actions/permissions`, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, allowed_actions: "all" }),
    });
  } catch {
    // Optional: requires Administration permission, which most tokens
    // intentionally omit. Never surfaced as a failure.
  }

  try {
    const r = await gh(g, `/repos/${owner}/${repo}/actions/workflows/${workflowFilename}/enable`, {
      method: "PUT",
    });
    // 404 here just means the workflow file hasn't been indexed yet (e.g.
    // this is the very first push) — expected and harmless. 403 means the
    // token genuinely cannot act on Actions for this repo.
    return { workflowEnablePermissionDenied: r.status === 403 };
  } catch {
    // Network-level failure reaching this specific endpoint — not a
    // permission signal, so don't misreport it as one.
    return { workflowEnablePermissionDenied: false };
  }
}

/**
 * GitHub's public API has no direct "is workflow_dispatch registered" field
 * — the workflow-get endpoint's `state` (active/disabled_*) confirms the
 * *file* is indexed and enabled, which is a real, distinct precondition, but
 * not final proof the dispatch trigger itself is ready (that propagation can
 * genuinely lag behind, especially for a brand-new workflow file). This polls
 * that real signal on the requested bounded schedule instead of guessing —
 * an already-registered workflow (the common case: unchanged file, or a repo
 * that's built before) resolves on the very first check with no wait at all.
 *
 * Also captures and returns the numeric workflow ID from this same response,
 * so the caller can dispatch against that instead of the filename.
 */
async function waitForWorkflowRegistration(
  g: GH,
  owner: string,
  repo: string,
  workflowFilename: string,
): Promise<{ registered: boolean; elapsedMs: number; finalState?: string; workflowId?: number }> {
  const backoffMs = [1000, 2000, 4000, 8000, 12000, 15000]; // ~42s total, per spec
  const start = Date.now();
  let finalState: string | undefined;
  let workflowId: number | undefined;

  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    const r = await gh<{ id?: number; state?: string }>(
      g,
      `/repos/${owner}/${repo}/actions/workflows/${workflowFilename}`,
    );
    if (r.status === 200 && r.body?.id) {
      finalState = r.body.state;
      workflowId = r.body.id;
      if (r.body.state === "active") {
        return { registered: true, elapsedMs: Date.now() - start, finalState, workflowId };
      }
    }
    if (attempt < backoffMs.length) {
      await new Promise((res) => setTimeout(res, backoffMs[attempt]));
    }
  }
  return { registered: false, elapsedMs: Date.now() - start, finalState, workflowId };
}

/** Skips the upload entirely when the content on GitHub already matches —
 *  avoids an unnecessary commit (and the registration wait that would
 *  otherwise follow it) on every single build when the workflow hasn't
 *  actually changed. Returns whether a write actually happened. */
export async function upsertWorkflowIfChanged(
  g: GH,
  repo: string,
  path: string,
  contentUtf8: string,
  message: string,
  branch: string,
): Promise<{ changed: boolean }> {
  const owner = g.login;
  const existing = await gh<{ content?: string; sha?: string }>(
    g,
    `/repos/${owner}/${repo}/contents/${encodeContentPath(path)}?ref=${encodeURIComponent(branch)}`,
  );
  if (existing.status === 200 && existing.body?.content) {
    try {
      const existingContent = decodeURIComponent(escape(atob(existing.body.content.replace(/\n/g, ""))));
      if (existingContent === contentUtf8) {
        return { changed: false };
      }
    } catch {
      // Couldn't decode the existing copy — fall through and just upload.
    }
  }
  await upsertFile(g, repo, path, contentUtf8, message, branch);
  return { changed: true };
}

/** Inputs declared by the copy of the workflow that currently lives on the repo. */
async function declaredInputs(
  g: GH,
  owner: string,
  repo: string,
  path: string,
): Promise<Set<string> | null> {
  const r = await gh<{ content?: string; encoding?: string }>(
    g,
    `/repos/${owner}/${repo}/contents/${encodeContentPath(path)}`,
  );
  if (r.status !== 200 || !r.body?.content) return null;
  let yaml: string;
  try {
    yaml = decodeURIComponent(escape(atob(r.body.content.replace(/\n/g, ""))));
  } catch {
    return null;
  }
  const m = yaml.match(/workflow_dispatch:\s*\n\s*inputs:\s*\n([\s\S]*?)(?:\n\S|\njobs:)/);
  const block = m?.[1] ?? yaml.split("inputs:")[1];
  if (!block) return null;
  const names = new Set<string>();
  for (const line of block.split("\n")) {
    const im = line.match(/^\s{6,}([A-Za-z0-9_-]+):/);
    if (im) names.add(im[1]);
  }
  return names.size ? names : null;
}

export async function dispatchWorkflow(
  g: GH,
  repo: string,
  workflowFilename: string,
  inputs: Record<string, string>,
  workflowPath?: string,
  onStage?: (stage: DispatchStage, detail?: string) => void,
): Promise<void> {
  const owner = g.login;
  const ref = await getDefaultBranch(g, owner, repo);
  const actionsState = await ensureActionsEnabled(g, owner, repo, workflowFilename);
  if (actionsState.workflowEnablePermissionDenied) {
    throw new GithubStageError(
      `GitHub refused (403) to enable the Android workflow on ${owner}/${repo}. This token cannot operate on GitHub Actions for this repository — grant it "Actions: Read and write" (fine-grained) or the \`workflow\` scope (classic), then reconnect GitHub in Settings.`,
      "actions-permission",
    );
  }

  // Deterministic registration handshake: confirm GitHub has actually
  // indexed this workflow (state: active) before ever attempting dispatch,
  // rather than firing the dispatch POST and hoping a retry outlives
  // whatever indexing delay GitHub is having. An already-registered
  // workflow (the common case) resolves on the first check with no wait.
  // This also captures the numeric workflow ID — the dispatch call below
  // targets that instead of the filename. GitHub's own docs say both are
  // accepted interchangeably, but the numeric ID is the more specific,
  // unambiguous identifier, and using it removes any possible dependency on
  // filename-to-workflow resolution being fully settled server-side.
  onStage?.("WORKFLOW_REGISTERING");
  const registration = await waitForWorkflowRegistration(g, owner, repo, workflowFilename);
  if (!registration.registered || !registration.workflowId) {
    throw new GithubStageError(
      `The Android workflow at ${owner}/${repo}@${ref} was uploaded, but GitHub had not finished registering its workflow_dispatch trigger after waiting ${Math.round(registration.elapsedMs / 1000)}s (workflow state reported by GitHub: ${registration.finalState ?? "unavailable"}). This is a genuine GitHub-side registration delay, not something retrying blindly fixes faster — please wait a minute and try again.`,
      "workflow-registration",
    );
  }
  const workflowId = registration.workflowId;
  onStage?.(
    "WORKFLOW_REGISTERED",
    `id=${workflowId}, state=${registration.finalState}, elapsed=${registration.elapsedMs}ms`,
  );

  // Registration is confirmed, so dispatch is attempted once — not retried
  // "blindly" hoping the trigger appears. Only genuinely transient failures
  // (a dropped connection, a rate limit, GitHub 5xx) get a short, bounded
  // retry; anything else, including a 422 that recurs despite confirmed
  // registration, fails immediately with a full diagnostic instead.
  onStage?.("DISPATCHING");
  let payloadInputs = inputs;
  let lastError = "";
  const networkRetrySchedule = [1000, 2000, 4000]; // short — real outages, not indexing delay

  for (let attempt = 0; attempt <= networkRetrySchedule.length; attempt++) {
    let d: { status: number; body: unknown };
    try {
      d = await gh(g, `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, {
        method: "POST",
        body: JSON.stringify({ ref, inputs: payloadInputs }),
      });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < networkRetrySchedule.length) {
        await new Promise((res) => setTimeout(res, networkRetrySchedule[attempt]));
        continue;
      }
      onStage?.("DISPATCH_FAILED", lastError);
      throw new GithubStageError(
        `Workflow dispatch failed: could not reach GitHub (${lastError}).`,
        "network",
      );
    }
    if (d.status < 300) {
      onStage?.("DISPATCH_ACCEPTED");
      return;
    }

    lastError = bodyText(d.body);

    if (transientStatus(d.status) && attempt < networkRetrySchedule.length) {
      await new Promise((res) => setTimeout(res, networkRetrySchedule[attempt]));
      continue;
    }

    if (d.status === 401 || d.status === 403) {
      onStage?.("DISPATCH_FAILED", `${d.status}`);
      throw new GithubStageError(explainGithubError(d.status, lastError, "actions"), categorize(d.status, "actions"));
    }
    if (d.status === 409) {
      onStage?.("DISPATCH_FAILED", "409");
      throw new GithubStageError(
        `Workflow dispatch conflict (409) on ref "${ref}": ${lastError || "another dispatch may already be in progress"}`,
        "workflow-dispatch",
      );
    }
    if (d.status === 404 || d.status === 422) {
      if (workflowPath && /unexpected inputs/i.test(lastError)) {
        const declared = await declaredInputs(g, owner, repo, workflowPath);
        if (declared) {
          const filtered: Record<string, string> = {};
          for (const [k, v] of Object.entries(inputs)) if (declared.has(k)) filtered[k] = v;
          payloadInputs = filtered;
          continue; // one immediate retry with the corrected input set, not a blind loop
        }
      }
      // This is the exact case the registration handshake above exists to
      // prevent — reaching it means dispatch was rejected *despite* GitHub
      // just having confirmed the workflow active and this call already
      // targeting the numeric workflow ID, not the filename. There is no
      // "still indexing" explanation left that's honestly true at this
      // point, so this does not suggest simply retrying — it re-fetches
      // both the workflow metadata and the actual file content on the
      // default branch and reports exactly what GitHub says right now.
      const [redefinition, fileCheck] = await Promise.all([
        gh<{ id?: number; state?: string; path?: string }>(
          g,
          `/repos/${owner}/${repo}/actions/workflows/${workflowId}`,
        ),
        inspectWorkflowFile(g, owner, repo, workflowPath ?? `.github/workflows/${workflowFilename}`, ref),
      ]);
      const diag = {
        workflowId,
        path: redefinition.body?.path ?? workflowPath ?? "unknown",
        state: redefinition.body?.state ?? "unknown",
        defaultBranch: ref,
        fileSha: fileCheck.sha ?? "unknown",
        fileContainsWorkflowDispatch: fileCheck.containsWorkflowDispatch,
        dispatchStatus: d.status,
      };
      // The on: block content itself contains no secrets (it's trigger
      // config, not build inputs), so it's safe to log and to surface in
      // the error — this is what actually lets a real structural mismatch
      // get diagnosed instead of trusting a second summary that could
      // itself be wrong.
      console.log(
        `[android-dispatch] post-422 diagnostic: workflowId=${diag.workflowId} path=${diag.path} state=${diag.state} default_branch=${diag.defaultBranch} file_sha=${diag.fileSha} file_has_workflow_dispatch=${diag.fileContainsWorkflowDispatch} dispatch_status=${diag.dispatchStatus} token_type=${g.token.startsWith("github_pat_") ? "fine-grained" : "classic-or-legacy"}\non: block per GitHub:\n${fileCheck.onBlockSnippet ?? "(not found)"}`,
      );
      onStage?.("DISPATCH_FAILED", `${d.status}`);
      // When the file is genuinely correct (structurally verified above,
      // not just assumed) and GitHub still rejects the dispatch, a
      // fine-grained PAT is the most likely remaining explanation — GitHub's
      // own community forum has multiple confirmed reports of this exact
      // endpoint rejecting fine-grained tokens even with correct permissions
      // granted, with a classic token + repo scope being the reliable fix.
      const tokenHint =
        diag.fileContainsWorkflowDispatch && g.token.startsWith("github_pat_")
          ? " The workflow file itself is confirmed correct, which points at the connected token: fine-grained PATs have documented reliability issues with this specific GitHub endpoint even when permissions look correct. Try reconnecting GitHub with a classic personal access token (repo scope) instead."
          : "";
      throw new GithubStageError(
        `GitHub registered workflow ${workflowId} but rejected workflow_dispatch. Workflow file trigger validation result: ${diag.fileContainsWorkflowDispatch ? "workflow_dispatch is correctly placed under the top-level on: key" : "workflow_dispatch is NOT correctly placed under the top-level on: key in the file GitHub currently serves"} (state=${diag.state}, path=${diag.path}, sha=${diag.fileSha}, branch=${diag.defaultBranch}, dispatch status=${d.status}: ${lastError}).${tokenHint} Actual on: block on GitHub:\n${fileCheck.onBlockSnippet ?? "(could not read on: block)"}`,
        "workflow-dispatch",
      );
    }

    onStage?.("DISPATCH_FAILED", `${d.status}`);
    throw new GithubStageError(`Workflow dispatch failed (${d.status}): ${lastError}`, "workflow-dispatch");
  }

  onStage?.("DISPATCH_FAILED", lastError);
  throw new GithubStageError(`Workflow dispatch failed: ${lastError || "no details from GitHub"}.`, "workflow-dispatch");
}


export async function findRunForBuild(
  g: GH,
  repo: string,
  workflowFilename: string,
  buildId: string,
  maxAttempts = 8,
): Promise<number | null> {
  // The workflow's `run-name` embeds the build_id, so we can correlate the run
  // exactly instead of guessing at "the most recent dispatch" (which may be a
  // previous, stale build for the same repo).
  for (let i = 0; i < maxAttempts; i++) {
    const r = await gh<{
      workflow_runs: Array<{ id: number; name?: string; display_title?: string; created_at?: string }>;
    }>(
      g,
      `/repos/${g.login}/${repo}/actions/workflows/${workflowFilename}/runs?event=workflow_dispatch&per_page=30`,
    );
    if (r.status === 200 && r.body?.workflow_runs) {
      const match = r.body.workflow_runs.find(
        (run) =>
          (run.display_title && run.display_title.includes(buildId)) ||
          (run.name && run.name.includes(buildId)),
      );
      if (match) return match.id;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  return null;
}

export async function getRun(
  g: GH,
  repo: string,
  runId: number,
): Promise<{
  id: number;
  name?: string;
  display_title?: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}> {
  const r = await withRetry(
    () =>
      gh<{
        id: number;
        name?: string;
        display_title?: string;
        status: string;
        conclusion: string | null;
        html_url: string;
      }>(g, `/repos/${g.login}/${repo}/actions/runs/${runId}`),
    (out) => transientStatus(out.status),
  );
  if (r.status >= 300 || !r.body) throw new Error(`Get run failed (${r.status})`);
  return r.body;
}

/** Best-effort cancel of an in-flight workflow run. */
export async function cancelRun(g: GH, repo: string, runId: number): Promise<boolean> {
  const r = await gh(g, `/repos/${g.login}/${repo}/actions/runs/${runId}/cancel`, {
    method: "POST",
  });
  return r.status < 300 || r.status === 409; // 409 = already finished
}

/** Deletes a workflow run (and its logs/artifacts) from the repo. */
export async function deleteRun(g: GH, repo: string, runId: number): Promise<boolean> {
  const r = await gh(g, `/repos/${g.login}/${repo}/actions/runs/${runId}`, { method: "DELETE" });
  return r.status < 300 || r.status === 404;
}

export async function getArtifactDownload(
  g: GH,
  repo: string,
  runId: number,
): Promise<ArrayBuffer | null> {
  let apk: { id: number; name: string } | undefined;
  for (let i = 0; i < 6; i++) {
    const list = await gh<{ artifacts: Array<{ id: number; name: string }> }>(
      g,
      `/repos/${g.login}/${repo}/actions/runs/${runId}/artifacts`,
    );
    if (list.status < 300 && list.body?.artifacts?.length) {
      apk = list.body.artifacts.find((a) => a.name.startsWith("apk-"));
      if (apk) break;
    }
    await new Promise((res) => setTimeout(res, 2500));
  }
  if (!apk) return null;
  const res = await withRetry(
    () =>
      fetch(`${API}/repos/${g.login}/${repo}/actions/artifacts/${apk!.id}/zip`, {
        headers: {
          Authorization: `Bearer ${g.token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "APKForge",
        },
        redirect: "follow",
      }),
    (out) => transientStatus(out.status),
  );
  if (!res.ok) throw new Error(`Artifact download failed (${res.status})`);
  const artifactZip = await res.arrayBuffer();
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(artifactZip);
  const apkFile = Object.values(zip.files).find(
    (f) => !f.dir && f.name.toLowerCase().endsWith(".apk"),
  );
  if (!apkFile) {
    throw new Error("APK artifact did not contain a release .apk file.");
  }
  return await apkFile.async("arraybuffer");
}

/** Names of the steps GitHub reports as failed, in run order. */
async function failedStepNames(g: GH, repo: string, runId: number): Promise<string[]> {
  const r = await gh<{
    jobs: Array<{ steps?: Array<{ number: number; name: string; conclusion: string | null }> }>;
  }>(g, `/repos/${g.login}/${repo}/actions/runs/${runId}/jobs`);
  const out: string[] = [];
  for (const job of r.body?.jobs ?? []) {
    for (const s of job.steps ?? []) {
      if (s.conclusion === "failure") out.push(`${s.number}_${s.name}`);
    }
  }
  return out;
}

export async function getFailureTail(
  g: GH,
  repo: string,
  runId: number,
): Promise<{ tail: string; summary?: string }> {
  const failedSteps = await failedStepNames(g, repo, runId).catch(() => [] as string[]);

  const res = await fetch(
    `${API}/repos/${g.login}/${repo}/actions/runs/${runId}/logs`,
    {
      headers: {
        Authorization: `Bearer ${g.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "APKForge",
      },
      redirect: "follow",
    },
  );
  if (!res.ok) return { tail: `(logs unavailable: ${res.status})` };

  // /logs returns a ZIP archive of per-step .txt files. Parse it and pull the
  // failing step (or the last step) so users get a real error message.
  try {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    const entries = Object.values(zip.files).filter(
      (f) => !f.dir && f.name.toLowerCase().endsWith(".txt"),
    );

    const norm = (s: string) => s.replace(/[^a-z0-9]+/gi, "").toLowerCase();

    let chosen: { name: string; text: string } | null = null;

    // 1. Authoritative: the step GitHub itself marked as failed.
    for (const stepName of failedSteps) {
      const target = norm(stepName);
      const match = entries.find((f) => {
        const base = f.name.split("/").pop() ?? f.name;
        return norm(base.replace(/\.txt$/i, "")) === target;
      });
      if (match) {
        chosen = { name: match.name, text: await match.async("string") };
        break;
      }
    }

    // 2. Fallback heuristics only when the jobs API gave us nothing.
    if (!chosen) {
      let marked: { name: string; text: string } | null = null;
      let generic: { name: string; text: string } | null = null;
      for (const f of entries) {
        const text = await f.async("string");
        if (/PREBUILD_VALIDATION_FAILED:|SIGNING_VALIDATION_FAILED:|APK_VERIFICATION_FAILED:|DEPENDENCY_VALIDATION_FAILED:|OAUTH_VALIDATION_FAILED:/.test(text)) {
          marked = { name: f.name, text };
        }
        if (/BUILD FAILED|What went wrong|##\[error\]|Process completed with exit code [1-9]/i.test(text)) {
          generic = { name: f.name, text };
        }
      }
      chosen = marked ?? generic;
    }

    if (!chosen && entries.length) {
      const last = entries[entries.length - 1];
      chosen = { name: last.name, text: await last.async("string") };
    }
    if (!chosen) return { tail: "(no log files in archive)" };

    const lines = chosen.text.split("\n");
    const tail = `--- ${chosen.name} ---\n` + lines.slice(-200).join("\n");
    return { tail, summary: summarizeFailure(chosen.text) };

  } catch (e) {
    return { tail: `(could not parse logs: ${(e as Error).message})` };
  }
}

export function summarizeFailure(text: string): string | undefined {
  const dep = text.match(/DEPENDENCY_VALIDATION_FAILED:\s*([^\n]+)/);
  if (dep?.[1]) return `Dependency check failed: ${dep[1].trim().slice(0, 220)}`;
  const iosSign = text.match(/IOS_SIGNING_VALIDATION_FAILED:\s*([^\n]+)/);
  if (iosSign?.[1]) return `iOS signing failed: ${iosSign[1].trim().slice(0, 220)}`;
  const ios = text.match(/IOS_VALIDATION_FAILED:\s*([^\n]+)/);
  if (ios?.[1]) return `iOS build check failed: ${ios[1].trim().slice(0, 220)}`;
  const trace = text.match(/BROWSER_TRACE_VERDICT:\s*(?!present end-to-end)([^\n]+)/);
  if (trace?.[1]) return `Browser plugin trace: ${trace[1].trim().slice(0, 220)}`;
  const oauth = text.match(/OAUTH_VALIDATION_FAILED:\s*([^\n]+)/);
  if (oauth?.[1]) return `OAuth readiness failed: ${oauth[1].replace(/^;\s*/, "").trim().slice(0, 220)}`;
  const sync = text.match(/SYNC_VALIDATION_FAILED:\s*([^\n]+)/);
  if (sync?.[1]) return sync[1].trim().slice(0, 240);
  const prebuild = text.match(/PREBUILD_VALIDATION_FAILED:\s*([^\n]+)/);
  if (prebuild?.[1]) return prebuild[1].trim().slice(0, 240);

  const apkVerify = text.match(/APK_VERIFICATION_FAILED:\s*([^\n]+)/);
  if (apkVerify?.[1]) return apkVerify[1].trim().slice(0, 240);
  const signingFailure = text.match(/SIGNING_VALIDATION_FAILED:\s*([^\n]+)/i);
  if (signingFailure?.[1]) return signingFailure[1].trim().slice(0, 240);
  if (/The web assets directory .* must contain an index\.html/i.test(text)) {
    return "Capacitor's configured webDir had no index.html. The builder now repairs webDir automatically — re-run the build.";
  }

  if (/Failed to install the following.*licences have not been accepted|You have not accepted the license agreements/i.test(text)) {
    return "Android SDK licences were not accepted on the runner. Re-run the build — the workflow now accepts them automatically.";
  }
  if (/google-services\.json is missing|File google-services\.json is missing/i.test(text)) {
    return "Firebase is used by this project but google-services.json is missing from the uploaded zip. Add it under android/app/ (or the project root) and re-upload.";
  }
  if (/Manifest merger failed/i.test(text)) {
    return "AndroidManifest merge conflict between plugins. See the pre-build report for the conflicting attribute.";
  }
  if (/requires a minSdk|uses-sdk:minSdkVersion .* cannot be smaller/i.test(text)) {
    return "A Capacitor plugin requires a higher Android minSdk than the project declares. The pre-build report lists the required level.";
  }
  if (/@capacitor\/(core|cli|android).*version mismatch|Capacitor major version mismatch/i.test(text)) {
    return "Capacitor packages are on mismatched major versions. Align @capacitor/core, @capacitor/cli and @capacitor/android in package.json.";
  }
  if (/EBADENGINE|engine "node" is incompatible|Unsupported engine/i.test(text)) {
    return "The selected Node.js version is incompatible with this project's dependencies. Pick the Node version your package.json engines field requires.";
  }

  if (/SIGNING_VALIDATION_PASSED/i.test(text) && /No key with alias .* found in keystore/i.test(text)) {
    return "Android signing validation passed, but Gradle could not find the validated key alias. Re-run the build so the updated workflow uses the validated alias.";
  }
  if (/No key with alias .* found in keystore/i.test(text)) {
    return "Configured key alias does not exist in the keystore. Re-add the keystore with the correct alias, or leave it blank when the keystore has exactly one alias so it can be auto-detected.";
  }
  if (/Invalid keystore password|saved store password does not open this keystore/i.test(text)) {
    return "Invalid keystore password. The saved store password does not open this keystore.";
  }
  if (/Invalid key password|Cannot recover key/i.test(text)) {
    return "Invalid key password for the selected alias. Update the key password in Settings.";
  }
  if (/Corrupted or unsupported keystore|Invalid keystore format|Unrecognized keystore format/i.test(text)) {
    return "Corrupted or unsupported keystore file. Upload a valid JKS or PKCS12 keystore.";
  }
  if (/No signing aliases found/i.test(text)) {
    return "No signing aliases found in the keystore. Upload a keystore containing a private key entry.";
  }
  if (/keystore password was incorrect/i.test(text)) {
    return "Signing keystore password is incorrect. Update the keystore in Settings (the store or key password saved doesn't match this .keystore file).";
  }
  if (/Failed to read key .* from store.*password.*incorrect/i.test(text)) {
    return "Signing key password is incorrect. Update the keystore in Settings.";
  }
  if (/EACCES|permission denied/i.test(text)) return "Permission denied while building — check keystore/file permissions.";
  if (/ENOSPC|no space left on device/i.test(text)) return "GitHub runner ran out of disk space.";
  if (/npm ERR!.*(ETARGET|ENOTFOUND|EAI_AGAIN)/i.test(text)) return "npm dependency resolution failed on the runner.";
  const javac = text.match(/^[^\n]*\.java:\d+:\s*error:\s*([^\n]+)/m);
  if (javac?.[1]) return `Android Java compile error: ${javac[1].trim().slice(0, 200)}`;
  const gradle = text.match(/Execution failed for task '([^']+)'\.\s*\n?\s*>\s*([^\n]+)/);
  if (gradle) return `Gradle task ${gradle[1]} failed: ${gradle[2].trim().slice(0, 200)}`;
  return undefined;
}
