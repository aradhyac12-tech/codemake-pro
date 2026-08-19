import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { ArrowLeft, Ban, Download, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { refreshBuildStatus, getArtifactUrl, retryBuild, cancelBuild } from "@/lib/pipeline.functions";

export const Route = createFileRoute("/_authenticated/build/$id")({
  component: BuildDetail,
});

type Build = {
  id: string;
  status: string;
  stage: string | null;
  platform: string;
  source_filename: string | null;
  source_size: number | null;
  error_summary: string | null;
  repo: string | null;
  github_run_id: number | null;
  codemagic_build_id: string | null;
  artifact_path: string | null;
  created_at: string;
};

const TERMINAL = new Set(["success", "failed", "cancelled"]);

function BuildDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const refresh = useServerFn(refreshBuildStatus);
  const getUrl = useServerFn(getArtifactUrl);
  const retry = useServerFn(retryBuild);
  const cancel = useServerFn(cancelBuild);

  const buildQ = useQuery({
    queryKey: ["build", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("builds")
        .select(
          "id, status, stage, platform, source_filename, source_size, error_summary, repo, github_run_id, codemagic_build_id, artifact_path, created_at",
        )
        .eq("id", id)
        .single();
      if (error) throw error;
      return data as Build;
    },
    refetchInterval: (q) => (TERMINAL.has(q.state.data?.status ?? "") ? false : 3000),
    refetchOnWindowFocus: true,
  });

  const logsQ = useQuery({
    queryKey: ["build_logs", id],
    queryFn: async () => {
      const { data } = await supabase
        .from("build_logs")
        .select("chunk, at")
        .eq("build_id", id)
        .order("at", { ascending: true });
      return data ?? [];
    },
    enabled: buildQ.data?.status === "failed" || buildQ.data?.status === "cancelled",
  });

  const refreshMut = useMutation({
    mutationFn: () => refresh({ data: { buildId: id } }),
    onSuccess: () => buildQ.refetch(),
    onError: (e) => toast.error((e as Error).message),
  });

  // refreshBuildStatus is what actually looks up the matching GitHub Actions
  // run (attaching github_run_id the moment it appears) and syncs status
  // (queued -> in_progress -> ...) from GitHub — the 3s poll above only
  // re-reads this app's own DB row, so without this it would never pick
  // either of those up until someone manually clicked Refresh. Dispatching a
  // build can legitimately leave github_run_id unset for a little while
  // (see dispatchWorkflow's own bounded retry), so this needs to keep
  // trying on its own rather than require a manual click to un-stick it.
  const status = buildQ.data?.status;
  useEffect(() => {
    if (!status || TERMINAL.has(status)) return;
    const interval = setInterval(() => {
      if (!refreshMut.isPending) refreshMut.mutate();
    }, 8000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, id]);

  const retryMut = useMutation({
    mutationFn: () => retry({ data: { buildId: id, appOrigin: window.location.origin } }),
    onSuccess: (res) => {
      toast.success("Retry queued as a new build.");
      if (res?.buildId && res.buildId !== id) {
        navigate({ to: "/build/$id", params: { id: res.buildId } });
      } else {
        buildQ.refetch();
      }
    },
    onError: (e) => toast.error(`Retry failed: ${(e as Error).message}`),
  });

  const cancelMut = useMutation({
    mutationFn: () => cancel({ data: { buildId: id } }),
    onSuccess: () => {
      toast.success("Build cancelled.");
      buildQ.refetch();
    },
    onError: (e) => toast.error((e as Error).message),
  });


  useEffect(() => {
    if (!buildQ.data) return;
    if (TERMINAL.has(buildQ.data.status)) return;
    const t = setInterval(() => refreshMut.mutate(), 3500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildQ.data?.status]);

  async function download() {
    try {
      const { url } = await getUrl({ data: { buildId: id } });
      window.open(url, "_blank");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const b = buildQ.data;

  return (
    <div>
      <Link to="/dashboard" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> All builds
      </Link>

      {!b && <p className="text-sm text-muted-foreground">Loading…</p>}

      {b && (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold tracking-tight">
                {b.source_filename ?? "Build"}
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {b.platform.toUpperCase()} · started {formatDistanceToNow(new Date(b.created_at), { addSuffix: true })}
              </p>
            </div>
            <StatusPill status={b.status} />
          </div>

          {(() => {
            const isIos = b.platform === "ios";
            // Stages reflect real progress, never a failure. A build that never
            // reached CI (no run id / dispatch failure) must not show green
            // "Queued" and "Building" rows.
            const dispatched = isIos ? !!b.codemagic_build_id : !!b.github_run_id;
            const running = b.status === "in_progress";
            const finished = b.status === "success" || (dispatched && b.status === "failed");
            const dispatchFailed = !dispatched && (b.status === "failed" || b.status === "cancelled");

            const queuedDone = dispatched;
            const buildStarted = dispatched && (running || b.status === "success" || b.status === "failed");
            const buildDone = b.status === "success" || (dispatched && b.status === "failed");
            return (
              <div className="mt-6 space-y-2">
                <Stage
                  label={isIos ? "Queued on Codemagic" : "Queued on GitHub"}
                  active={queuedDone || !dispatchFailed}
                  done={queuedDone}
                  spinning={!dispatched && b.status === "pending"}
                  failed={dispatchFailed}
                />
                <Stage
                  label={isIos ? "Building IPA" : "Building APK"}
                  active={buildStarted}
                  done={buildDone}
                  spinning={running}
                  failed={dispatched && b.status === "failed" && !buildDone}
                />
                <Stage
                  label="Signed & ready"
                  active={b.status === "success"}
                  done={b.status === "success"}
                  failed={b.status === "failed" && finished}
                />
              </div>
            );
          })()}

          {b.status === "success" && (
            <Button className="mt-6 w-full" size="lg" onClick={download}>
              <Download className="mr-2 h-4 w-4" /> Download signed {b.platform === "ios" ? "IPA" : "APK"}
            </Button>
          )}

          {(b.status === "failed" || b.status === "cancelled") && (
            <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
              <p className="text-sm font-medium text-red-400">
                {b.status === "cancelled" ? "Build cancelled" : "Build failed"}
              </p>
              {b.error_summary && <p className="mt-1 text-xs text-red-300">{b.error_summary}</p>}
              {logsQ.data && logsQ.data.length > 0 && (
                <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-black/40 p-3 text-[10px] leading-relaxed text-red-100">
                  {logsQ.data.map((l) => l.chunk).join("\n")}
                </pre>
              )}
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-2">
            {!TERMINAL.has(b.status) && (
              <>
                <Button variant="outline" size="sm" onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending}>
                  <RefreshCw className={`mr-1 h-3.5 w-3.5 ${refreshMut.isPending ? "animate-spin" : ""}`} /> Refresh
                </Button>
                <Button variant="outline" size="sm" onClick={() => cancelMut.mutate()} disabled={cancelMut.isPending}>
                  <Ban className="mr-1 h-3.5 w-3.5" /> Cancel build
                </Button>
              </>
            )}
            {(b.status === "failed" || b.status === "cancelled") && (
              <Button variant="outline" size="sm" onClick={() => retryMut.mutate()} disabled={retryMut.isPending}>
                <RefreshCw className={`mr-1 h-3.5 w-3.5 ${retryMut.isPending ? "animate-spin" : ""}`} /> Retry build
              </Button>
            )}
            {b.platform !== "ios" && b.repo && b.github_run_id && (
              <a
                href={`https://github.com/${b.repo}/actions/runs/${b.github_run_id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
              >
                View on GitHub <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {b.platform === "ios" && b.codemagic_build_id && (
              <a
                href={`https://codemagic.io/app/${""}/build/${b.codemagic_build_id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
              >
                View on Codemagic <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  queued: "bg-blue-500/15 text-blue-400",
  in_progress: "bg-amber-500/15 text-amber-400",
  success: "bg-emerald-500/15 text-emerald-400",
  failed: "bg-red-500/15 text-red-400",
  cancelled: "bg-muted text-muted-foreground",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[status] ?? "bg-muted"}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function Stage({
  label,
  active,
  done,
  spinning,
  failed,
}: {
  label: string;
  active: boolean;
  done: boolean;
  spinning?: boolean;
  failed?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 rounded-lg border p-3 ${active ? "border-border bg-card" : "border-border/50 bg-card/50 opacity-60"}`}>
      <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${failed ? "bg-red-500/20 text-red-400" : done ? "bg-emerald-500/20 text-emerald-400" : active ? "bg-amber-500/20 text-amber-400" : "bg-muted text-muted-foreground"}`}>
        {spinning ? <Loader2 className="h-3 w-3 animate-spin" /> : done ? "✓" : failed ? "×" : "•"}
      </span>
      <span className="text-sm">{label}</span>
    </div>
  );
}
