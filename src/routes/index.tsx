import { createFileRoute, Link } from "@tanstack/react-router";
import { Smartphone, Zap, ShieldCheck, GitBranch } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-5 py-5">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Smartphone className="h-4 w-4" />
          </div>
          <span className="text-base font-semibold tracking-tight">APKForge</span>
        </div>
        <Link
          to="/auth"
          className="inline-flex items-center rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Sign in
        </Link>
      </header>

      <main className="mx-auto max-w-5xl px-5 pb-24 pt-8 sm:pt-16">
        <div className="max-w-2xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Android APK builds live
          </div>
          <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">
            Ship signed Android APKs
            <br />
            straight from your phone.
          </h1>
          <p className="mt-5 text-lg text-muted-foreground">
            Upload a Capacitor project zip, we push it to your GitHub, run the build on GitHub
            Actions, and hand you a signed <code className="rounded bg-muted px-1 py-0.5 text-sm">.apk</code>{" "}
            to install. No Mac, no Windows, no Android Studio.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/auth"
              className="inline-flex items-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Get started
            </Link>
            <a
              href="#how"
              className="inline-flex items-center rounded-md border border-border px-5 py-2.5 text-sm font-medium hover:bg-muted"
            >
              How it works
            </a>
          </div>
        </div>

        <div id="how" className="mt-20 grid gap-6 sm:grid-cols-3">
          <Feature
            icon={<Zap className="h-5 w-5" />}
            title="Phone never compiles"
            body="Validation and stripping happen in your browser; the build runs on a real Linux runner."
          />
          <Feature
            icon={<GitBranch className="h-5 w-5" />}
            title="Uses your GitHub"
            body="We push your project to a private repo on your account and trigger a workflow you can inspect."
          />
          <Feature
            icon={<ShieldCheck className="h-5 w-5" />}
            title="Your keystore, your key"
            body="Signing keystores are stored per-user and injected into the build as GitHub Actions secrets."
          />
        </div>

        <div className="mt-16 rounded-xl border border-border bg-muted/30 p-6 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">iOS?</strong> iOS builds require an active Apple
            Developer Program membership ($99/yr) — no cloud service bypasses this. iOS support is
            coming after Android is rock-solid.
          </p>
        </div>
      </main>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </div>
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
