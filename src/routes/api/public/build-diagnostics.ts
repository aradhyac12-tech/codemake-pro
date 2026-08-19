import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const diagnosticSchema = z.object({
  buildId: z.string().uuid(),
  token: z.string().min(16).max(256),
  stage: z.string().min(1).max(80),
  at: z.string().max(64).optional(),
  extra: z.record(z.unknown()).optional(),
});

function sanitize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "string") return value.slice(0, 500);
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (/token|secret|password|refresh|access/i.test(key)) continue;
      out[key.slice(0, 80)] = sanitize(nested);
    }
    return out;
  }
  return String(value).slice(0, 200);
}

export const Route = createFileRoute("/api/public/build-diagnostics")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        try {
          const payload = diagnosticSchema.parse(await request.json());
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: build, error } = await supabaseAdmin
            .from("builds")
            .select("id, diagnostic_token")
            .eq("id", payload.buildId)
            .maybeSingle();

          if (error || !build || build.diagnostic_token !== payload.token) {
            return Response.json({ ok: false }, { status: 401, headers: corsHeaders });
          }

          const safe = sanitize(payload.extra ?? {});
          await supabaseAdmin.from("build_logs").insert({
            build_id: payload.buildId,
            chunk: `[android-oauth] ${payload.stage} ${JSON.stringify(safe)}`,
          });

          return Response.json({ ok: true }, { headers: corsHeaders });
        } catch {
          return Response.json({ ok: false }, { status: 400, headers: corsHeaders });
        }
      },
    },
  },
});