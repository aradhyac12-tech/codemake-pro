// Codemagic REST client — shared workspace account.
// Docs: https://docs.codemagic.io/rest-api/overview/
const API = "https://api.codemagic.io";

export type CodemagicEnv = {
  token: string;
  appId: string;
};

export function requireCodemagicEnv(): CodemagicEnv {
  const token = process.env.CODEMAGIC_API_TOKEN;
  const appId = process.env.CODEMAGIC_APP_ID;
  if (!token || !appId) {
    throw new Error(
      "iOS builds aren't configured. Workspace admin must set CODEMAGIC_API_TOKEN and CODEMAGIC_APP_ID.",
    );
  }
  return { token, appId };
}

export function requireIosSigningEnv(): {
  issuerId: string;
  keyId: string;
  privateKey: string;
} {
  const issuerId = process.env.APP_STORE_CONNECT_ISSUER_ID;
  const keyId = process.env.APP_STORE_CONNECT_KEY_ID;
  const privateKey = process.env.APP_STORE_CONNECT_PRIVATE_KEY;
  if (!issuerId || !keyId || !privateKey) {
    throw new Error(
      "iOS signing isn't configured. Workspace admin must set APP_STORE_CONNECT_ISSUER_ID, APP_STORE_CONNECT_KEY_ID, and APP_STORE_CONNECT_PRIVATE_KEY.",
    );
  }
  return { issuerId, keyId, privateKey };
}

async function retry<T>(fn: () => Promise<T>, isTransient: (v: T) => boolean, attempts = 3): Promise<T> {
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

async function cm<T = unknown>(
  { token }: Pick<CodemagicEnv, "token">,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T | null }> {
  const doFetch = async () => {
    const res = await fetch(API + path, {
      ...init,
      headers: {
        "x-auth-token": token,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let body: T | null = null;
    if (text) {
      try {
        body = JSON.parse(text) as T;
      } catch {
        body = text as unknown as T;
      }
    }
    return { status: res.status, body };
  };
  const idempotent = !init.method || init.method.toUpperCase() === "GET";
  if (!idempotent) return doFetch();
  return retry(doFetch, (out) => out.status === 429 || out.status >= 500);
}

export type CodemagicBuildResponse = { buildId: string };

export async function startBuild(
  env: CodemagicEnv,
  args: {
    workflowId: string;
    branch: string;
    variables: Record<string, string>;
  },
): Promise<string> {
  const r = await cm<CodemagicBuildResponse>(env, "/builds", {
    method: "POST",
    body: JSON.stringify({
      appId: env.appId,
      workflowId: args.workflowId,
      branch: args.branch,
      environment: { variables: args.variables },
    }),
  });
  if (r.status >= 300 || !r.body?.buildId) {
    throw new Error(
      `Codemagic start failed (${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`,
    );
  }
  return r.body.buildId;
}

export type CodemagicBuild = {
  build: {
    _id: string;
    status: string; // queued | preparing | building | testing | publishing | finished
    finishedAt?: string;
    startedAt?: string;
    buildActions?: Array<{ name: string; status: string; log?: string }>;
    artefacts?: Array<{ name: string; url: string; type?: string }>;
    version?: string;
    buildUrl?: string;
  };
};

export async function getBuild(
  env: CodemagicEnv,
  buildId: string,
): Promise<CodemagicBuild["build"]> {
  const r = await cm<CodemagicBuild>(env, `/builds/${buildId}`);
  if (r.status >= 300 || !r.body?.build) {
    throw new Error(`Codemagic get build failed (${r.status})`);
  }
  return r.body.build;
}

export async function downloadArtifact(
  env: CodemagicEnv,
  url: string,
): Promise<ArrayBuffer> {
  const res = await retry(
    () => fetch(url, { headers: { "x-auth-token": env.token }, redirect: "follow" }),
    (out) => out.status === 429 || out.status >= 500,
  );
  if (!res.ok) throw new Error(`Artifact download failed (${res.status})`);
  return await res.arrayBuffer();
}

/**
 * Resolve the IPA bytes from a finished build: prefer a direct `.ipa` artefact,
 * otherwise unwrap the first zip/archive artefact and extract an `.ipa` inside.
 */
export async function resolveIpaBuffer(
  env: CodemagicEnv,
  build: CodemagicBuild["build"],
): Promise<ArrayBuffer | null> {
  const artefacts = build.artefacts ?? [];
  const direct = artefacts.find((a) => a.name.toLowerCase().endsWith(".ipa"));
  if (direct) return await downloadArtifact(env, direct.url);

  const archives = artefacts.filter((a) => /\.(zip|xcarchive\.zip|tar)$/i.test(a.name));
  for (const archive of archives) {
    try {
      const buf = await downloadArtifact(env, archive.url);
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(buf);
      const entry = Object.values(zip.files).find(
        (f) => !f.dir && f.name.toLowerCase().endsWith(".ipa"),
      );
      if (entry) return await entry.async("arraybuffer");
    } catch {
      // try the next archive
    }
  }
  return null;
}

// Codemagic status → APKForge status
export function mapCodemagicStatus(status: string): {
  status: "queued" | "in_progress" | "success" | "failed";
  terminal: boolean;
  conclusion?: "success" | "failure";
} {
  const s = status.toLowerCase();
  if (s === "queued" || s === "preparing" || s === "fetching") {
    return { status: "queued", terminal: false };
  }
  if (s === "finished") {
    return { status: "success", terminal: true, conclusion: "success" };
  }
  if (
    s === "failed" ||
    s === "canceled" ||
    s === "cancelled" ||
    s === "timeout" ||
    s === "skipped"
  ) {
    return { status: "failed", terminal: true, conclusion: "failure" };
  }
  return { status: "in_progress", terminal: false };
}

export function tailFromActions(build: CodemagicBuild["build"]): string {
  const actions = build.buildActions ?? [];
  const failing = [...actions].reverse().find((a) => a.status !== "success");
  const tail = (failing?.log ?? actions[actions.length - 1]?.log ?? "").split("\n").slice(-200);
  return tail.join("\n") || `(no log available; status=${build.status})`;
}

export async function cancelBuild(env: CodemagicEnv, buildId: string): Promise<void> {
  await cm(env, `/builds/${buildId}/cancel`, { method: "POST" });
}
