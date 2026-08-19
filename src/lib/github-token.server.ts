export type GithubProbe = {
  login: string;
  tokenType: "classic" | "fine-grained" | "unknown";
  scopes: string[];
  notes: string[];
};

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "APKForge",
  };
}

function rateLimitMessage(res: Response): string | null {
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining !== "0") return null;
  const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0);
  const when = reset ? new Date(reset * 1000).toISOString().slice(11, 16) + " UTC" : "shortly";
  return `GitHub rate limit reached for this token. It resets at ${when} — try again then.`;
}

/**
 * Server-side token validation. Runs on the server (no browser CORS/iframe in
 * play), trims the pasted value, and turns each GitHub failure mode into its
 * own actionable message instead of a blanket "check scopes".
 */
export async function probeGithubToken(rawToken: string): Promise<GithubProbe> {
  const token = rawToken.trim();
  if (!token) throw new Error("Paste a token first — the field was empty.");
  if (/\s/.test(token)) {
    throw new Error("That token contains a space or line break. Copy it again without wrapping.");
  }

  let res: Response;
  try {
    res = await fetch("https://api.github.com/user", { headers: ghHeaders(token) });
  } catch (e) {
    throw new Error(
      `Could not reach GitHub from the build backend (${(e as Error).message}). This is a network problem, not your token — try again.`,
    );
  }

  if (res.status === 401) {
    throw new Error(
      "GitHub says this token is invalid or expired (401). Generate a new token and paste it again.",
    );
  }
  if (res.status === 403) {
    const limited = rateLimitMessage(res);
    if (limited) throw new Error(limited);
    const sso = res.headers.get("x-github-sso");
    if (sso) {
      throw new Error(
        "This token needs SSO authorization for your organization. Open the token page on GitHub and click “Authorize” for the org, then try again.",
      );
    }
    throw new Error(
      `GitHub refused this token (403): ${(await res.text()).slice(0, 200) || "no details"}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `GitHub returned ${res.status} while checking the token: ${(await res.text()).slice(0, 200)}`,
    );
  }

  const me = (await res.json()) as { login?: string };
  if (!me.login) throw new Error("GitHub accepted the token but returned no account login.");

  const scopeHeader = res.headers.get("x-oauth-scopes");
  const notes: string[] = [];

  // Classic PATs report their granted scopes in this header. Fine-grained
  // tokens never send it — absence is NOT a missing-scope failure.
  if (scopeHeader !== null && scopeHeader.trim() !== "") {
    const scopes = scopeHeader
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const hasRepo = scopes.includes("repo");
    const hasWorkflow = scopes.includes("workflow");
    const missing = [
      ...(hasRepo ? [] : ["repo"]),
      ...(hasWorkflow ? [] : ["workflow"]),
    ];
    if (missing.length) {
      throw new Error(
        `This classic token authenticates as @${me.login} but is missing the ${missing
          .map((m) => `\`${m}\``)
          .join(" and ")} scope${missing.length > 1 ? "s" : ""}. Granted: ${scopes.join(", ") || "none"}.`,
      );
    }
    return { login: me.login, tokenType: "classic", scopes, notes };
  }

  // Fine-grained (or GitHub App) token: verify capability instead of scopes.
  // Generic scope names don't exist for these, so probe the exact endpoints
  // the Android pipeline actually depends on, against the real build repo
  // where possible — a token that merely "looks" configured but can't
  // actually read Workflows or write Secrets is the whole reason builds have
  // failed past this validation step before.
  const repoRes = await fetch("https://api.github.com/user/repos?per_page=1&affiliation=owner", {
    headers: ghHeaders(token),
  }).catch(() => null);
  if (repoRes && !repoRes.ok && repoRes.status !== 404) {
    notes.push(
      `Repository listing returned ${repoRes.status}. If builds fail later, re-issue the token with Contents: Read and write and Workflows: Read and write.`,
    );
  }

  const buildRepoRes = await fetch(`https://api.github.com/repos/${me.login}/apkforge-builds`, {
    headers: ghHeaders(token),
  }).catch(() => null);

  if (buildRepoRes && buildRepoRes.status === 404) {
    notes.push(
      "The apkforge-builds repository doesn't exist yet — it will be created automatically on your first build, so Workflows/Secrets permissions can't be probed until then.",
    );
  } else if (buildRepoRes && buildRepoRes.ok) {
    // Repo exists and is readable — now probe the two permissions that are
    // otherwise invisible until a build actually fails partway through:
    // Workflows (read/write) and Actions Secrets (read/write). Both are
    // plain read-only GETs, so this never mutates anything.
    const [workflowsRes, secretsRes] = await Promise.all([
      fetch("https://api.github.com/repos/" + me.login + "/apkforge-builds/actions/workflows", {
        headers: ghHeaders(token),
      }).catch(() => null),
      fetch(
        "https://api.github.com/repos/" + me.login + "/apkforge-builds/actions/secrets/public-key",
        { headers: ghHeaders(token) },
      ).catch(() => null),
    ]);

    if (workflowsRes && workflowsRes.status === 403) {
      throw new Error(
        `This token authenticates as @${me.login} and can see apkforge-builds, but GitHub refused to list its Actions workflows (403). Re-issue the token with Workflows: Read and write on that repository.`,
      );
    }
    if (secretsRes && secretsRes.status === 403) {
      throw new Error(
        `This token authenticates as @${me.login} and can see apkforge-builds, but GitHub refused access to its Actions secrets (403). Re-issue the token with Secrets: Read and write on that repository — without it, the build's keystore and signing secrets can never be written.`,
      );
    }
    if (workflowsRes?.ok) notes.push("Workflows permission verified on apkforge-builds.");
    if (secretsRes?.ok) notes.push("Actions Secrets permission verified on apkforge-builds.");
  } else if (buildRepoRes && !buildRepoRes.ok) {
    notes.push(
      `Could not check apkforge-builds directly (GitHub returned ${buildRepoRes.status}). Permissions will be re-verified when you start a build.`,
    );
  }

  notes.push(
    "Fine-grained token detected. Make sure it grants Contents, Actions and Workflows read/write on the build repository (or all repositories).",
  );
  // GitHub's own community forum has multiple independent, confirmed reports
  // of fine-grained PATs being rejected by the workflow_dispatch endpoint
  // specifically — sometimes even with every relevant permission granted
  // correctly (github.com/orgs/community/discussions/174782,
  // github.com/orgs/community/discussions/58868). The workaround people
  // consistently report working is a classic PAT with the `repo` scope
  // instead. This is a real, documented GitHub-side limitation, not
  // something a permission tweak on the fine-grained token reliably fixes —
  // surfaced here up front so it doesn't have to be discovered only after a
  // build fails with a confusing 422.
  notes.push(
    "Heads up: fine-grained tokens have documented reliability issues specifically with GitHub's workflow-dispatch endpoint — sometimes rejecting the request even when every permission above is correctly granted. If a build ever fails with \"Workflow does not have 'workflow_dispatch' trigger\" despite the workflow clearly having one, the most reliable fix is switching to a classic token with the `repo` scope instead of troubleshooting fine-grained permissions further.",
  );

  return {
    login: me.login,
    tokenType: scopeHeader === null ? "fine-grained" : "unknown",
    scopes: [],
    notes,
  };
}
