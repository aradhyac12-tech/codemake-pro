/**
 * Retention: builds older than one month are removed everywhere — database
 * rows, logs, stored source zips and artifacts, plus their GitHub Actions runs
 * (cancelled first when still in flight, then deleted from the repo).
 */
export const RETENTION_DAYS = 30;

type PurgeResult = { deleted: number; runsDeleted: number; errors: string[] };

export async function purgeOldBuilds(userId?: string): Promise<PurgeResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let query = supabaseAdmin
    .from("builds")
    .select("id, user_id, status, platform, repo, github_run_id, artifact_path, source_path, logo_path")
    .lt("created_at", cutoff)
    .limit(200);
  if (userId) query = query.eq("user_id", userId);

  const { data: builds, error } = await query;
  if (error) return { deleted: 0, runsDeleted: 0, errors: [error.message] };
  if (!builds?.length) return { deleted: 0, runsDeleted: 0, errors: [] };

  const errors: string[] = [];
  let runsDeleted = 0;

  // GitHub tokens are per user; fetch each owner's connection once.
  const tokens = new Map<string, { token: string; login: string } | null>();
  async function tokenFor(uid: string) {
    if (!tokens.has(uid)) {
      const { data } = await supabaseAdmin
        .from("github_connections")
        .select("github_login, access_token")
        .eq("user_id", uid)
        .maybeSingle();
      tokens.set(uid, data ? { token: data.access_token, login: data.github_login } : null);
    }
    return tokens.get(uid) ?? null;
  }

  for (const b of builds) {
    try {
      if (b.platform !== "ios" && b.repo && b.github_run_id) {
        const g = await tokenFor(b.user_id);
        if (g) {
          const { cancelRun, deleteRun } = await import("./github.server");
          const repoName = b.repo.split("/")[1];
          if (!["success", "failed", "cancelled"].includes(b.status)) {
            await cancelRun(g, repoName, b.github_run_id).catch(() => {});
          }
          if (await deleteRun(g, repoName, b.github_run_id)) runsDeleted += 1;
        }
      }
    } catch (e) {
      errors.push(`run cleanup ${b.id}: ${(e as Error).message}`);
    }

    const artifacts = [b.artifact_path].filter(
      (p): p is string => !!p && !p.endsWith(".zip"),
    );
    const sources = [b.source_path, b.logo_path].filter((p): p is string => !!p);
    if (b.artifact_path?.endsWith(".zip")) sources.push(b.artifact_path);
    if (artifacts.length) {
      await supabaseAdmin.storage.from("build-artifacts").remove(artifacts).catch(() => {});
    }
    if (sources.length) {
      await supabaseAdmin.storage.from("build-sources").remove(sources).catch(() => {});
    }
    await supabaseAdmin.from("build_logs").delete().eq("build_id", b.id);
  }

  const ids = builds.map((b) => b.id);
  const { error: delErr } = await supabaseAdmin.from("builds").delete().in("id", ids);
  if (delErr) errors.push(delErr.message);

  return { deleted: delErr ? 0 : ids.length, runsDeleted, errors };
}