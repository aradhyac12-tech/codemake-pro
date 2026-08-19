import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  isRedirect,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Smartphone, Settings as SettingsIcon, Home, LogOut } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { reportLovableError } from "@/lib/lovable-error-reporting";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // A thrown/misconfigured Supabase client (missing env vars) must not
    // render the generic error boundary for a protected route — the correct
    // outcome is the same as "not signed in": send the person to /auth,
    // where the page itself renders even without a working Supabase client
    // (see the try/catch there).
    try {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) throw redirect({ to: "/auth" });
      return { user: data.user };
    } catch (err) {
      if (isRedirect(err)) throw err; // a real redirect() from inside the try — let it through
      console.error("[supabase] auth check failed:", err);
      reportLovableError(err, { boundary: "authenticated_before_load" });
      throw redirect({ to: "/auth" });
    }
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const { data } = supabase.auth.onAuthStateChange((event) => {
        if (event === "SIGNED_OUT") navigate({ to: "/auth", replace: true });
      });
      unsubscribe = () => data.subscription.unsubscribe();
    } catch (error) {
      console.error("[supabase] auth state sync unavailable:", error);
      reportLovableError(error, { boundary: "authenticated_layout_auth_state_sync" });
    }
    return () => unsubscribe?.();
  }, [navigate]);

  async function signOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    router.invalidate();
  }

  return (
    <div className="min-h-screen bg-background pb-24 text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-5 py-3">
          <Link to="/dashboard" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Smartphone className="h-4 w-4" />
            </div>
            <span className="text-sm font-semibold tracking-tight">APKForge</span>
          </Link>
          <div className="flex items-center gap-1">
            <span className="hidden text-xs text-muted-foreground sm:inline">{user.email}</span>
            <Button variant="ghost" size="icon" onClick={signOut} disabled={signingOut} title="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-5 py-6">
        <Outlet />
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl">
          <TabLink to="/dashboard" icon={<Home className="h-5 w-5" />} label="Builds" />
          <TabLink to="/settings" icon={<SettingsIcon className="h-5 w-5" />} label="Settings" />
        </div>
      </nav>
    </div>
  );
}

function TabLink({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <Link
      to={to}
      className="flex flex-1 flex-col items-center gap-1 py-3 text-xs text-muted-foreground [&.active]:text-foreground"
      activeProps={{ className: "active" }}
    >
      {icon}
      {label}
    </Link>
  );
}
