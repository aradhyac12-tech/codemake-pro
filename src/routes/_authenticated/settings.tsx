import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Github, KeyRound, Plus, Trash2, ExternalLink, Apple, CheckCircle2, AlertTriangle } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { iosAvailability, buildPreflight } from "@/lib/pipeline.functions";
import { connectGithub, disconnectGithub } from "@/lib/github-connect.functions";

export const Route = createFileRoute("/_authenticated/settings")({
  component: Settings,
});

function Settings() {
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <PreflightSection />
      <GitHubSection />
      <KeystoreSection />
      <IosSection />
    </div>
  );
}

function PreflightSection() {
  const preflightFn = useServerFn(buildPreflight);
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["build_preflight"],
    queryFn: () => preflightFn(),
  });

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <CheckCircle2 className="h-4 w-4" /> Build readiness
      </h2>
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        {(data?.checks ?? []).map((check) => (
          <div key={check.name} className="flex items-start gap-3">
            {check.ok ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            )}
            <div>
              <p className="text-sm font-medium">{check.name}</p>
              <p className="text-xs text-muted-foreground">{check.detail}</p>
            </div>
          </div>
        ))}
        {!data && (
          <p className="text-xs text-muted-foreground">Running readiness checks…</p>
        )}
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? "Checking…" : "Re-run checks"}
        </Button>
      </div>
    </section>
  );
}


function IosSection() {
  const iosFn = useServerFn(iosAvailability);
  const { data } = useQuery({ queryKey: ["ios_availability"], queryFn: () => iosFn() });
  const ready = !!data?.codemagicConfigured && !!data?.signingConfigured && !!data?.repoConfigured;
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Apple className="h-4 w-4" /> iOS signing (workspace)
      </h2>
      <div className="rounded-xl border border-border bg-card p-4">
        {ready ? (
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-400" />
            <div>
              <p className="text-sm font-medium">iOS builds are ready to run.</p>
              <p className="text-xs text-muted-foreground">
                Signed via shared Codemagic + App Store Connect API key.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <div className="text-xs text-muted-foreground">
              <p className="text-sm font-medium text-foreground">iOS signing not fully configured</p>
              <p className="mt-1">Workspace admin must set these secrets:</p>
              <ul className="mt-2 space-y-0.5 font-mono">
                <li className={data?.codemagicConfigured ? "text-emerald-400" : ""}>
                  {data?.codemagicConfigured ? "✓" : "•"} CODEMAGIC_API_TOKEN
                </li>
                <li className={data?.codemagicConfigured ? "text-emerald-400" : ""}>
                  {data?.codemagicConfigured ? "✓" : "•"} CODEMAGIC_APP_ID
                </li>
                <li className={data?.signingConfigured ? "text-emerald-400" : ""}>
                  {data?.signingConfigured ? "✓" : "•"} APP_STORE_CONNECT_ISSUER_ID
                </li>
                <li className={data?.signingConfigured ? "text-emerald-400" : ""}>
                  {data?.signingConfigured ? "✓" : "•"} APP_STORE_CONNECT_KEY_ID
                </li>
                <li className={data?.signingConfigured ? "text-emerald-400" : ""}>
                  {data?.signingConfigured ? "✓" : "•"} APP_STORE_CONNECT_PRIVATE_KEY
                </li>
                <li className={data?.repoConfigured ? "text-emerald-400" : ""}>
                  {data?.repoConfigured ? "✓" : "•"} APKFORGE_CENTRAL_GH_TOKEN
                </li>
                <li className={data?.repoConfigured ? "text-emerald-400" : ""}>
                  {data?.repoConfigured ? "✓" : "•"} APKFORGE_CENTRAL_GH_REPO (owner/name)
                </li>
              </ul>
              <p className="mt-2">
                The GitHub repo must also be connected to the shared Codemagic app so it can read <code>codemagic.yaml</code>.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function GitHubSection() {
  const qc = useQueryClient();
  const connectFn = useServerFn(connectGithub);
  const disconnectFn = useServerFn(disconnectGithub);
  const { data: gh, isLoading } = useQuery({
    queryKey: ["github_connection"],
    queryFn: async () => {
      const { data } = await supabase
        .from("github_connections")
        .select("github_login, repo_name, token_type, scopes")
        .maybeSingle();
      return data;
    },
  });

  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveToken() {
    setSaving(true);
    setError(null);
    try {
      // Validated server-side: no browser -> GitHub call, so a CORS/network
      // failure can never be reported as a scope problem.
      const res = await connectFn({ data: { token } });
      toast.success(`Connected as @${res.login}`);
      for (const note of res.notes) toast.info(note);
      setToken("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["github_connection"] });
      qc.invalidateQueries({ queryKey: ["build_preflight"] });
    } catch (e) {
      setError((e as Error).message);
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect GitHub? Builds will stop until you reconnect.")) return;
    try {
      await disconnectFn();
      qc.invalidateQueries({ queryKey: ["github_connection"] });
      qc.invalidateQueries({ queryKey: ["build_preflight"] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Github className="h-4 w-4" /> GitHub
      </h2>
      <div className="rounded-xl border border-border bg-card p-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : gh ? (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Connected as {gh.github_login}</p>
              <p className="text-xs text-muted-foreground">
                {gh.token_type === "classic"
                  ? `Classic token · scopes: ${gh.scopes || "unknown"}`
                  : gh.token_type
                    ? "Fine-grained token · needs Contents, Actions and Workflows read/write"
                    : "Builds run in a private repo on your account."}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={disconnect}>
              Disconnect
            </Button>
          </div>
        ) : (
          <div>
            <p className="text-sm">Connect your GitHub account to run builds.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Uses a fine-grained personal access token you generate — scopes:{" "}
              <code className="rounded bg-muted px-1">repo</code>,{" "}
              <code className="rounded bg-muted px-1">workflow</code>.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href="https://github.com/settings/personal-access-tokens/new"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                Create a token <ExternalLink className="h-3 w-3" />
              </a>
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">Paste token</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Connect GitHub</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <Label htmlFor="pat">Personal access token</Label>
                    <Input
                      id="pat"
                      type="password"
                      placeholder="github_pat_…"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">
                      Stored encrypted at rest, only readable by the build backend.
                    </p>
                    {error && (
                      <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
                        {error}
                      </p>
                    )}
                  </div>
                  <DialogFooter>
                    <Button onClick={saveToken} disabled={!token.trim() || saving}>
                      {saving ? "Verifying…" : "Save"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

type Keystore = {
  id: string;
  name: string;
  key_alias: string;
  created_at: string;
};

function KeystoreSection() {
  const qc = useQueryClient();
  const { data: keystores } = useQuery({
    queryKey: ["keystores"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("keystores")
        .select("id, name, key_alias, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Keystore[];
    },
  });

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [ksPass, setKsPass] = useState("");
  const [keyPass, setKeyPass] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!file) return toast.error("Pick a .jks or .keystore file");
    setSaving(true);
    try {
      const buf = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await supabase.from("keystores").insert({
        user_id: userData.user!.id,
        name,
        key_alias: alias,
        keystore_password: ksPass,
        key_password: keyPass,
        keystore_base64: base64,
      });
      if (error) throw error;
      toast.success("Keystore saved.");
      setName(""); setAlias(""); setKsPass(""); setKeyPass(""); setFile(null);
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["keystores"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function del(id: string) {
    if (!confirm("Delete this keystore? Builds using it will fail.")) return;
    await supabase.from("keystores").delete().eq("id", id);
    qc.invalidateQueries({ queryKey: ["keystores"] });
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <KeyRound className="h-4 w-4" /> Signing keystores
        </h2>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline">
              <Plus className="mr-1 h-4 w-4" /> Add
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Android keystore</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label htmlFor="ks-name">Name</Label>
                <Input id="ks-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My release keystore" />
              </div>
              <div>
                <Label htmlFor="ks-file">Keystore file (.jks / .keystore)</Label>
                <Input
                  id="ks-file"
                  type="file"
                  accept=".jks,.keystore"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </div>
              <div>
                <Label htmlFor="ks-alias">Key alias</Label>
                <Input id="ks-alias" value={alias} onChange={(e) => setAlias(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="ks-pass">Keystore password</Label>
                  <Input id="ks-pass" type="password" value={ksPass} onChange={(e) => setKsPass(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="key-pass">Key password</Label>
                  <Input id="key-pass" type="password" value={keyPass} onChange={(e) => setKeyPass(e.target.value)} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Stored per-user; injected into GitHub Actions as repo secrets at build time.
              </p>
            </div>
            <DialogFooter>
              <Button onClick={save} disabled={saving || !name || !alias || !ksPass || !keyPass || !file}>
                {saving ? "Saving…" : "Save keystore"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-2">
        {(!keystores || keystores.length === 0) && (
          <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No keystores yet. Add one to sign your APKs.
          </div>
        )}
        {keystores?.map((k) => (
          <div key={k.id} className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{k.name}</p>
              <p className="text-xs text-muted-foreground">alias: {k.key_alias}</p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => del(k.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
