import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Package, Trash2, Loader2, Ban } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { deleteBuild, cancelBuild, purgeOldBuildsFn } from "@/lib/pipeline.functions";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

type Build = {
  id: string;
  status: string;
  platform: string;
  source_filename: string | null;
  source_size: number | null;
  error_summary: string | null;
  created_at: string;
};

const TERMINAL = new Set(["success", "failed", "cancelled"]);

function Dashboard() {
  const purge = useServerFn(purgeOldBuildsFn);
  const purged = useRef(false);

  // Retention sweep: builds older than a month (and their GitHub runs) go away.
  useEffect(() => {
    if (purged.current) return;
    purged.current = true;
    purge().catch(() => {});
  }, [purge]);

  const { data: builds, isLoading } = useQuery({
    queryKey: ["builds"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("builds")
        .select("id, status, platform, source_filename, source_size, error_summary, created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data as Build[];
    },
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
  });

  const totals = (builds ?? []).reduce(
    (acc, b) => {
      acc.total += 1;
      acc[b.status] = (acc[b.status] ?? 0) + 1;
      if (!TERMINAL.has(b.status)) acc.active += 1;
      return acc;
    },
    { total: 0, active: 0 } as Record<string, number>,
  );

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Builds</h1>
        <Link to="/new-build">
          <Button size="sm">
            <Plus className="mr-1 h-4 w-4" /> New build
          </Button>
        </Link>
      </div>

      {(builds?.length ?? 0) > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <StatCard label="Total" value={totals.total} />
          <StatCard label="Active" value={totals.active} />
          <StatCard label="Queued" value={(totals.queued ?? 0) + (totals.pending ?? 0)} />
          <StatCard label="Success" value={totals.success ?? 0} tone="emerald" />
          <StatCard label="Failed" value={totals.failed ?? 0} tone="red" />
        </div>
      )}

      <div className="mt-6 space-y-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && (!builds || builds.length === 0) && <EmptyState />}
        {builds?.map((b) => <BuildRow key={b.id} build={b} />)}
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: "emerald" | "red" }) {
  const color =
    tone === "emerald" ? "text-emerald-400" : tone === "red" ? "text-red-400" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${color}`}>{value}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Package className="h-5 w-5 text-muted-foreground" />
      </div>
      <h3 className="mt-3 text-base font-medium">No builds yet</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Upload a Capacitor project zip to trigger your first Android build.
      </p>
      <Link to="/new-build">
        <Button className="mt-5" size="sm">
          <Plus className="mr-1 h-4 w-4" /> New build
        </Button>
      </Link>
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

function BuildRow({ build }: { build: Build }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const del = useServerFn(deleteBuild);
  const cancel = useServerFn(cancelBuild);
  const nonTerminal = !TERMINAL.has(build.status);

  const delMut = useMutation({
    mutationFn: () => del({ data: { buildId: build.id } }),
    onSuccess: () => {
      toast.success("Build deleted");
      qc.invalidateQueries({ queryKey: ["builds"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const cancelMut = useMutation({
    mutationFn: () => cancel({ data: { buildId: build.id } }),
    onSuccess: () => {
      toast.success("Build cancelled");
      qc.invalidateQueries({ queryKey: ["builds"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  function onDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this build and its artifact?")) return;
    delMut.mutate();
  }

  function onCancel(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Cancel this running build?")) return;
    cancelMut.mutate();
  }

  return (
    <div
      role="link"
      onClick={() => navigate({ to: "/build/$id", params: { id: build.id } })}
      className="block cursor-pointer rounded-xl border border-border bg-card p-4 transition hover:bg-muted"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {build.source_filename ?? "Untitled"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {build.platform.toUpperCase()} · {formatDistanceToNow(new Date(build.created_at), { addSuffix: true })}
            {build.source_size ? ` · ${formatBytes(build.source_size)}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              STATUS_STYLES[build.status] ?? "bg-muted text-muted-foreground"
            }`}
          >
            {build.status.replace("_", " ")}
          </span>
          {nonTerminal && (
            <button
              aria-label="Cancel build"
              onClick={onCancel}
              disabled={cancelMut.isPending}
              className="rounded-md p-1.5 text-muted-foreground transition hover:bg-amber-500/15 hover:text-amber-400 disabled:opacity-50"
            >
              {cancelMut.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Ban className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <button
            aria-label="Delete build"
            onClick={onDelete}
            disabled={delMut.isPending}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-red-500/15 hover:text-red-400 disabled:opacity-50"
          >
            {delMut.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
      {build.error_summary && (
        <p className="mt-2 line-clamp-2 text-xs text-red-400">{build.error_summary}</p>
      )}
    </div>
  );
}
