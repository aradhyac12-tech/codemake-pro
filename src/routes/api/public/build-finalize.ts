import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const finalizeSchema = z.object({
  buildId: z.string().uuid(),
  token: z.string().min(16).max(256),
  runId: z.union([z.string(), z.number()]).optional(),
  jobStatus: z.string().max(40).optional(),
});

async function finalizeAndroidBuild(buildId: string, token: string, runIdInput: string | number | undefined) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: build, error } = await supabaseAdmin
    .from("builds")
    .select("id, user_id, status, repo, github_run_id, diagnostic_token")
    .eq("id", buildId)
    .maybeSingle();

  if (error || !build || build.diagnostic_token !== token) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (["success", "failed", "cancelled"].includes(build.status)) {
    return Response.json({ ok: true, status: build.status });
  }

  const runId = Number(runIdInput ?? build.github_run_id ?? 0);
  if (!runId || !build.repo) {
    await supabaseAdmin.from("builds").update({ status: "queued" }).eq("id", buildId);
    return Response.json({ ok: true, status: "queued" });
  }

  const { data: gh } = await supabaseAdmin
    .from("github_connections")
    .select("github_login, access_token")
    .eq("user_id", build.user_id)
    .maybeSingle();

  if (!gh) {
    await supabaseAdmin
      .from("builds")
      .update({ status: "failed", error_summary: "GitHub connection was not found while finalizing the Android build." })
      .eq("id", buildId);
    return Response.json({ ok: true, status: "failed" });
  }

  const { getRun, getArtifactDownload, getFailureTail } = await import("@/lib/github.server");
  const repoName = build.repo.split("/")[1];
  const g = { token: gh.access_token, login: gh.github_login };
  const run = await getRun(g, repoName, runId);

  if (run.status !== "completed") {
    const status = run.status === "in_progress" ? "in_progress" : "queued";
    await supabaseAdmin.from("builds").update({ status, github_run_id: runId }).eq("id", buildId);
    return Response.json({ ok: true, status });
  }

  if (run.conclusion === "success") {
    const apkBuf = await getArtifactDownload(g, repoName, runId);
    if (!apkBuf) throw new Error("No APK artifact produced by workflow.");
    const artifactPath = `${build.user_id}/${build.id}.apk`;
    const { error: upErr } = await supabaseAdmin.storage
      .from("build-artifacts")
      .upload(artifactPath, new Blob([apkBuf], { type: "application/vnd.android.package-archive" }), {
        upsert: true,
        contentType: "application/vnd.android.package-archive",
      });
    if (upErr) throw upErr;
    await supabaseAdmin
      .from("builds")
      .update({ status: "success", artifact_path: artifactPath, github_run_id: runId, error_summary: null })
      .eq("id", buildId);
    return Response.json({ ok: true, status: "success" });
  }

  const { tail, summary } = await getFailureTail(g, repoName, runId);
  if (tail) await supabaseAdmin.from("build_logs").insert({ build_id: build.id, chunk: tail });
  await supabaseAdmin
    .from("builds")
    .update({ status: "failed", github_run_id: runId, error_summary: summary ?? `Workflow ${run.conclusion}. See logs.` })
    .eq("id", buildId);
  return Response.json({ ok: true, status: "failed" });
}

export const Route = createFileRoute("/api/public/build-finalize")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const payload = finalizeSchema.parse(await request.json());
          return await finalizeAndroidBuild(payload.buildId, payload.token, payload.runId);
        } catch (error) {
          return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
        }
      },
    },
  },
});