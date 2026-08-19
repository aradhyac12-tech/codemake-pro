import { createFileRoute } from "@tanstack/react-router";

/**
 * Retention cron endpoint. Deletes builds older than one month across all
 * users, including their GitHub Actions runs. Requires the shared secret so
 * the public path cannot be abused.
 */
async function handle(request: Request) {
  const secret = process.env["APKFORGE_CRON_SECRET"];
  if (!secret) {
    return Response.json(
      { ok: false, error: "APKFORGE_CRON_SECRET is not configured." },
      { status: 503 },
    );
  }
  const provided =
    request.headers.get("x-cron-secret") ??
    new URL(request.url).searchParams.get("secret") ??
    "";
  if (provided !== secret) return new Response("Unauthorized", { status: 401 });

  const { purgeOldBuilds } = await import("@/lib/purge.server");
  const result = await purgeOldBuilds();
  return Response.json({ ok: true, ...result });
}

export const Route = createFileRoute("/api/public/purge-builds")({
  server: {
    handlers: {
      POST: async ({ request }) => handle(request),
      GET: async ({ request }) => handle(request),
    },
  },
});