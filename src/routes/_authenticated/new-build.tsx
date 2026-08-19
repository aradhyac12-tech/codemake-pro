import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Upload,
  FileArchive,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  KeyRound,
  Github,
  Smartphone,
  Apple,
  Info,
} from "lucide-react";

import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validateAndStrip, isValidBundleId, type ValidationOk } from "@/lib/validate-zip";
import { formatBytes } from "@/lib/format";
import { dispatchBuild, iosAvailability } from "@/lib/pipeline.functions";

export const Route = createFileRoute("/_authenticated/new-build")({
  component: NewBuild,
});

type Keystore = { id: string; name: string; key_alias: string };
type Platform = "android" | "ios";

function NewBuild() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const dispatchFn = useServerFn(dispatchBuild);
  const iosFn = useServerFn(iosAvailability);

  const [platform, setPlatform] = useState<Platform>("android");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<string>("");
  const [pct, setPct] = useState(0);
  const [result, setResult] = useState<ValidationOk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedKeystoreId, setSelectedKeystoreId] = useState<string | null>(null);
  const [appName, setAppName] = useState("");
  const [bundleId, setBundleId] = useState("");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [nodeVersion, setNodeVersion] = useState<string>("22");
  const [creating, setCreating] = useState(false);

  const { data: keystores } = useQuery({
    queryKey: ["keystores"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("keystores")
        .select("id, name, key_alias")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Keystore[];
    },
  });

  const { data: gh } = useQuery({
    queryKey: ["github_connection"],
    queryFn: async () => {
      const { data } = await supabase
        .from("github_connections")
        .select("github_login")
        .maybeSingle();
      return data;
    },
  });

  const { data: iosAvail } = useQuery({
    queryKey: ["ios_availability"],
    queryFn: () => iosFn(),
  });

  const iosReady =
    !!iosAvail?.codemagicConfigured && !!iosAvail?.signingConfigured && !!iosAvail?.repoConfigured;

  // when result changes, pre-fill fields
  useEffect(() => {
    if (result) {
      setAppName(result.appName ?? result.packageName ?? "");
      setBundleId(result.bundleId ?? "");
      const req = result.nodeRequirement;
      if (req?.major && req.major >= 20 && req.major <= 24) {
        setNodeVersion(String(req.major));
      }
    }
  }, [result]);

  async function onFile(f: File) {
    setFile(f);
    setResult(null);
    setError(null);
    setBusy(true);
    try {
      const r = await validateAndStrip(f, (p, n) => {
        setPhase(p);
        if (typeof n === "number") setPct(n);
      });
      if (!r.ok) setError(r.reason);
      else {
        setResult(r);
        for (const w of r.warnings) toast.warning(w);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const bundleIdValid = isValidBundleId(bundleId.trim());

  const canStart =
    !!result && bundleIdValid && (platform === "android" ? !!gh && !!selectedKeystoreId : iosReady);

  const blockedReason = !result
    ? "Upload and validate a project zip first."
    : !bundleId.trim()
      ? "Enter a bundle ID (reverse-DNS, e.g. com.acme.app)."
      : !bundleIdValid
        ? "Bundle ID must be reverse-DNS with at least two segments, letters/digits/underscore only (e.g. com.acme.app)."
        : platform === "android"
          ? !gh
            ? "Connect GitHub in Settings before starting an Android build."
            : !selectedKeystoreId
              ? "Select a signing keystore."
              : null
          : !iosReady
            ? "iOS signing isn't configured for this workspace yet."
            : null;

  async function startBuild() {
    if (!result) return;
    if (!isValidBundleId(bundleId.trim())) {
      return toast.error("Enter a valid reverse-DNS bundle ID, e.g. com.acme.app");
    }
    if (creating) return;
    const majorNum = parseInt(nodeVersion, 10);
    if (!(majorNum >= 20 && majorNum <= 24)) {
      return toast.error("Pick a Node.js version between 20 and 24.");
    }
    const req = result.nodeRequirement;
    if (req?.major) {
      const src = req.source === "nvmrc" ? ".nvmrc" : "engines.node";
      if (req.major < 20 || req.major > 24) {
        return toast.error(
          `Project ${src} requires Node ${req.raw}, which is outside the supported 20–24 range.`,
        );
      }
      if (req.strict && majorNum !== req.major) {
        return toast.error(
          `Project ${src} pins Node ${req.raw}. Switch the picker to Node ${req.major} before building.`,
        );
      }
    }
    if (platform === "android") {
      if (!gh) return toast.error("Connect GitHub first in Settings.");
      if (!selectedKeystoreId) return toast.error("Pick a signing keystore first.");
    } else {
      if (!iosReady) return toast.error("iOS signing isn't configured yet.");
    }

    setCreating(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const user = userData.user;
      if (!user) throw new Error("Sign in again before starting a build.");
      const userId = user.id;
      const path = `${userId}/${crypto.randomUUID()}.zip`;
      const diagnosticToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;

      const { error: upErr } = await supabase.storage
        .from("build-sources")
        .upload(path, result.strippedZip, { contentType: "application/zip", upsert: false });
      if (upErr) throw upErr;

      let logoPath: string | null = null;
      if (logoFile) {
        const ext = (logoFile.name.split(".").pop() || "png").toLowerCase();
        logoPath = `${userId}/logos/${crypto.randomUUID()}.${ext}`;
        const { error: logoErr } = await supabase.storage
          .from("build-sources")
          .upload(logoPath, logoFile, { contentType: logoFile.type || "image/png", upsert: false });
        if (logoErr) throw logoErr;
      }

      const { data: build, error: insErr } = await supabase
        .from("builds")
        .insert({
          user_id: userId,
          status: "pending",
          platform,
          keystore_id: platform === "android" ? selectedKeystoreId : null,
          source_filename: file?.name ?? null,
          source_size: result.strippedSize,
          source_path: path,
          project_kind: result.projectKind,
          app_name: appName || null,
          bundle_id: bundleId || null,
          web_dir: result.webDir ?? null,
          logo_path: logoPath,
          node_version: nodeVersion,
          diagnostic_token: diagnosticToken,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;

      toast.success(
        `Build queued. Dispatching to ${platform === "android" ? "GitHub" : "Codemagic"}…`,
      );
      try {
        await dispatchFn({ data: { buildId: build.id, appOrigin: window.location.origin } });
      } catch (e) {
        toast.error(`Dispatch failed: ${(e as Error).message}`);
      }
      navigate({ to: "/build/$id", params: { id: build.id } });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">New build</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Upload your project zip — Capacitor or any web app. We'll auto-inject Capacitor if needed.
      </p>

      {/* Platform toggle */}
      <div className="mt-5 grid grid-cols-2 gap-2 rounded-xl bg-muted p-1">
        <PlatformBtn active={platform === "android"} onClick={() => setPlatform("android")}>
          <Smartphone className="h-4 w-4" /> Android APK
        </PlatformBtn>
        <PlatformBtn active={platform === "ios"} onClick={() => setPlatform("ios")}>
          <Apple className="h-4 w-4" /> iOS IPA
        </PlatformBtn>
      </div>

      {platform === "ios" && !iosReady && (
        <div className="mt-3 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="text-xs text-amber-200/90">
            <p className="font-medium text-amber-300">iOS signing not configured</p>
            <p className="mt-1">
              A workspace admin needs to set up Codemagic + App Store Connect credentials.
              {!iosAvail?.codemagicConfigured &&
                " Missing: CODEMAGIC_API_TOKEN / CODEMAGIC_APP_ID."}
              {!iosAvail?.signingConfigured &&
                " Missing: APP_STORE_CONNECT_ISSUER_ID / KEY_ID / PRIVATE_KEY."}
              {!iosAvail?.repoConfigured &&
                " Missing: APKFORGE_CENTRAL_GH_TOKEN / APKFORGE_CENTRAL_GH_REPO."}
            </p>
          </div>
        </div>
      )}

      {/* Step 1: Upload */}
      <section className="mt-6">
        <StepHeader n={1} title="Choose project zip" done={!!result} />
        {!result && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="mt-3 flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card px-5 py-10 text-center transition hover:bg-muted disabled:opacity-60"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Upload className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium">{file ? file.name : "Tap to pick a .zip"}</p>
            <p className="text-xs text-muted-foreground">Up to 500 MB · Capacitor or any web app</p>
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />

        {busy && (
          <div className="mt-3 rounded-xl border border-border bg-card p-4">
            <p className="text-sm">{phase}…</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <p className="text-sm font-medium text-red-400">Can't use this zip</p>
              <p className="mt-1 text-sm text-red-300/90">{error}</p>
              <button
                onClick={() => inputRef.current?.click()}
                className="mt-3 text-xs font-medium text-red-300 underline"
              >
                Pick another file
              </button>
            </div>
          </div>
        )}

        {result && (
          <ValidationSummary
            file={file!}
            result={result}
            onReset={() => {
              setResult(null);
              setFile(null);
            }}
          />
        )}
      </section>

      {result && (
        <>
          {/* Step 2: App metadata */}
          <section className="mt-6">
            <StepHeader n={2} title="App details" done={!!bundleId} />
            <div className="mt-3 space-y-3 rounded-xl border border-border bg-card p-4">
              <div>
                <Label htmlFor="app-name">App name</Label>
                <Input
                  id="app-name"
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                  placeholder="My App"
                />
              </div>
              <div>
                <Label htmlFor="bundle">Bundle ID (reverse-DNS)</Label>
                <Input
                  id="bundle"
                  value={bundleId}
                  onChange={(e) => setBundleId(e.target.value)}
                  placeholder="com.example.myapp"
                />
                {bundleId.trim() && !bundleIdValid ? (
                  <p className="mt-1 text-xs text-red-400">
                    Invalid format. Use reverse-DNS with 2+ segments, e.g. <code>com.acme.app</code>
                    .
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {result.bundleIdSource === "derived"
                      ? "Auto-generated from your project name — replace it if you already have a registered ID."
                      : result.bundleIdSource
                        ? `Detected from ${result.bundleIdSource}.`
                        : "Must match the App ID registered in App Store Connect for iOS builds."}
                  </p>
                )}
              </div>
              <div>
                <Label>App icon (optional)</Label>
                <div className="mt-2 flex items-center gap-3">
                  <label className="relative flex h-16 w-16 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-muted/40 hover:bg-muted">
                    {logoPreview ? (
                      <img
                        src={logoPreview}
                        alt="App icon preview"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <Upload className="h-5 w-5 text-muted-foreground" />
                    )}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        if (f.size > 5 * 1024 * 1024) {
                          toast.error("Icon must be under 5 MB");
                          return;
                        }
                        setLogoFile(f);
                        setLogoPreview(URL.createObjectURL(f));
                      }}
                    />
                  </label>
                  <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {logoFile ? (
                      <>
                        <p className="truncate text-foreground">{logoFile.name}</p>
                        <button
                          type="button"
                          onClick={() => {
                            setLogoFile(null);
                            setLogoPreview(null);
                          }}
                          className="mt-1 underline"
                        >
                          Remove
                        </button>
                      </>
                    ) : (
                      <p>
                        Square PNG recommended (1024×1024). If skipped, we'll auto-detect an icon
                        inside your project or fall back to the Capacitor default.
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div>
                <Label>Node.js version</Label>
                <div className="mt-2 grid grid-cols-5 gap-2">
                  {["20", "21", "22", "23", "24"].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setNodeVersion(v)}
                      className={`rounded-lg border px-2 py-2 text-sm font-medium transition ${
                        nodeVersion === v
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-card text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Installed on the GitHub Actions runner via{" "}
                  <code className="rounded bg-muted px-1">actions/setup-node</code>.
                </p>
                {(() => {
                  const req = result.nodeRequirement;
                  if (!req) return null;
                  const src = req.source === "nvmrc" ? ".nvmrc" : "engines.node";
                  const outOfRange = req.major && (req.major < 20 || req.major > 24);
                  const mismatch =
                    req.strict && req.major && String(req.major) !== nodeVersion && !outOfRange;
                  if (outOfRange) {
                    return (
                      <p className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
                        Detected {src}: <code>{req.raw}</code>. Only Node 20–24 is supported — the
                        build will fail.
                      </p>
                    );
                  }
                  if (mismatch) {
                    return (
                      <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
                        Detected {src}: <code>{req.raw}</code>. Switch to Node {req.major} to match
                        your project.
                      </p>
                    );
                  }
                  return (
                    <p className="mt-2 text-xs text-emerald-400">
                      Auto-detected {src}: <code>{req.raw}</code> → Node {req.major ?? nodeVersion}{" "}
                      preselected.
                    </p>
                  );
                })()}
              </div>
              {result.projectKind !== "capacitor-full" && (
                <div className="flex items-start gap-2 rounded-lg bg-primary/5 p-2 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  <span>
                    {result.projectKind === "web-app"
                      ? `We'll add Capacitor for you in the cloud build (webDir: ${result.webDir}).`
                      : "We'll add the missing native platform in the cloud build."}
                  </span>
                </div>
              )}
            </div>
          </section>

          {/* Step 3: platform-specific */}
          {platform === "android" ? (
            <>
              <section className="mt-6">
                <StepHeader n={3} title="GitHub connection" done={!!gh} />
                {gh ? (
                  <div className="mt-3 flex items-center gap-3 rounded-xl border border-border bg-card p-4">
                    <Github className="h-5 w-5 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">Connected as {gh.github_login}</p>
                      <p className="text-xs text-muted-foreground">
                        Build runs in a private repo on your account.
                      </p>
                    </div>
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  </div>
                ) : (
                  <SettingsRow icon={<Github className="h-5 w-5" />} label="Connect GitHub" />
                )}
              </section>

              <section className="mt-6">
                <StepHeader n={4} title="Signing keystore" done={!!selectedKeystoreId} />
                {keystores && keystores.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {keystores.map((k) => (
                      <button
                        key={k.id}
                        onClick={() => setSelectedKeystoreId(k.id)}
                        className={`flex w-full items-center gap-3 rounded-xl border p-4 text-left transition ${
                          selectedKeystoreId === k.id
                            ? "border-primary bg-primary/5"
                            : "border-border bg-card hover:bg-muted"
                        }`}
                      >
                        <KeyRound className="h-4 w-4 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{k.name}</p>
                          <p className="text-xs text-muted-foreground">alias: {k.key_alias}</p>
                        </div>
                        {selectedKeystoreId === k.id && (
                          <CheckCircle2 className="h-4 w-4 text-primary" />
                        )}
                      </button>
                    ))}
                    <Link
                      to="/settings"
                      className="block rounded-xl border border-dashed border-border p-3 text-center text-xs text-muted-foreground hover:bg-muted"
                    >
                      Manage keystores
                    </Link>
                  </div>
                ) : (
                  <SettingsRow
                    icon={<KeyRound className="h-5 w-5" />}
                    label="Add a signing keystore"
                  />
                )}
              </section>
            </>
          ) : (
            <section className="mt-6">
              <StepHeader n={3} title="iOS signing" done={iosReady} />
              <div className="mt-3 rounded-xl border border-border bg-card p-4">
                <div className="flex items-center gap-3">
                  <Apple className="h-5 w-5 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {iosReady ? "Workspace credentials configured" : "Not configured"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Signed via a shared Codemagic account + App Store Connect API key.
                    </p>
                  </div>
                  {iosReady && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
                </div>
              </div>
            </section>
          )}

          <Button
            className="mt-8 w-full"
            size="lg"
            disabled={!canStart || creating}
            onClick={startBuild}
          >
            {creating ? "Uploading…" : `Start ${platform === "android" ? "Android" : "iOS"} build`}
          </Button>
          {!canStart && !creating && blockedReason && (
            <p className="mt-2 text-center text-xs text-amber-400">{blockedReason}</p>
          )}
        </>
      )}
    </div>
  );
}

function PlatformBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function SettingsRow({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <Link
      to="/settings"
      className="mt-3 flex items-center justify-between rounded-xl border border-border bg-card p-4"
    >
      <div className="flex items-center gap-3">
        {icon}
        <span className="text-sm font-medium">{label}</span>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </Link>
  );
}

function StepHeader({ n, title, done }: { n: number; title: string; done: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
          done ? "bg-emerald-500/20 text-emerald-400" : "bg-muted text-muted-foreground"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
    </div>
  );
}

function ValidationSummary({
  file,
  result,
  onReset,
}: {
  file: File;
  result: ValidationOk;
  onReset: () => void;
}) {
  const savedPct = Math.round((1 - result.strippedSize / result.originalSize) * 100);
  return (
    <div className="mt-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <FileArchive className="mt-0.5 h-5 w-5 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{file.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatBytes(result.originalSize)} → {formatBytes(result.strippedSize)}
            {savedPct > 0 && ` (${savedPct}% smaller after stripping)`}
          </p>
        </div>
        <button onClick={onReset} className="text-xs text-muted-foreground underline">
          Change
        </button>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <Meta label="Kind" value={result.projectKind} />
        <Meta label="Package" value={result.packageName ?? "—"} />
        <Meta label="Capacitor" value={result.capacitorVersion ?? "will be added"} />
        <Meta label="webDir" value={result.webDir ?? "—"} />
      </dl>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-foreground">{value}</dd>
    </div>
  );
}
