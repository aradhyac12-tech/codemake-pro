import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const finalizeSchema = z.object({
  buildId: z.string().uuid(),
  token: z.string().min(16).max(256),
  codemagicBuildId: z.string().max(120).optional(),
});

async function finalizeIosBuild(
  buildId: string,
  token: string,
  codemagicBuildIdInput: string | undefined,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: build, error } = await supabaseAdmin
    .from("builds")
    .select("id, user_id, status, codemagic_build_id, diagnostic_token")
    .eq("id", buildId)
    .maybeSingle();

  if (error || !build || build.diagnostic_token !== token) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (["success", "failed", "cancelled"].includes(build.status)) {
    return Response.json({ ok: true, status: build.status });
  }

  const cmBuildId = codemagicBuildIdInput ?? build.codemagic_build_id;
  if (!cmBuildId) {
    return Response.json({ ok: true, status: build.status });
  }

  const {
    requireCodemagicEnv,
    getBuild,
    mapCodemagicStatus,
    tailFromActions,
    resolveIpaBuffer,
  } = await import("@/lib/codemagic.server");

  const cm = requireCodemagicEnv();
  const cmBuild = await getBuild(cm, cmBuildId);
  const mapped = mapCodemagicStatus(cmBuild.status);

  if (!mapped.terminal) {
    await supabaseAdmin
      .from("builds")
      .update({ status: mapped.status, codemagic_build_id: cmBuildId })
      .eq("id", buildId);
    return Response.json({ ok: true, status: mapped.status });
  }

  if (mapped.conclusion === "success") {
    const buf = await resolveIpaBuffer(cm, cmBuild);
    if (!buf) throw new Error("Codemagic finished but no .ipa artifact was found.");
    const artifactPath = `${build.user_id}/${build.id}.ipa`;
    const { error: upErr } = await supabaseAdmin.storage
      .from("build-artifacts")
      .upload(artifactPath, new Blob([buf], { type: "application/octet-stream" }), {
        upsert: true,
        contentType: "application/octet-stream",
      });
    if (upErr) throw upErr;
    await supabaseAdmin
      .from("builds")
      .update({
        status: "success",
        artifact_path: artifactPath,
        codemagic_build_id: cmBuildId,
        error_summary: null,
      })
      .eq("id", buildId);
    return Response.json({ ok: true, status: "success" });
  }

  const tail = tailFromActions(cmBuild);
  const { summarizeFailure } = await import("@/lib/github.server");
  if (tail) await supabaseAdmin.from("build_logs").insert({ build_id: buildId, chunk: tail });
  await supabaseAdmin
    .from("builds")
    .update({
      status: "failed",
      codemagic_build_id: cmBuildId,
      error_summary: summarizeFailure(tail) ?? `Codemagic build ${cmBuild.status}.`,
    })
    .eq("id", buildId);
  return Response.json({ ok: true, status: "failed" });
}

export const Route = createFileRoute("/api/public/build-ios-finalize")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const payload = finalizeSchema.parse(await request.json());
          return await finalizeIosBuild(payload.buildId, payload.token, payload.codemagicBuildId);
        } catch (error) {
          return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
        }
      },
    },
  },
});
