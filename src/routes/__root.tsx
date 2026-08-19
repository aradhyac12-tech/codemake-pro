import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { supabase } from "../integrations/supabase/client";
import { Toaster } from "../components/ui/sonner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

const TITLE = "APKForge — Build signed Android APKs from your phone";
const DESC =
  "Upload a Capacitor project zip from your phone, and get a signed APK back. No laptop, no Xcode, no Android Studio.";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: "#0a0a0a" },
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { title: "Apk-ipa converter from zip" },
      { property: "og:title", content: "Apk-ipa converter from zip" },
      { name: "twitter:title", content: "Apk-ipa converter from zip" },
      { name: "description", content: "Cloud Build Buddy is a mobile app that builds Android APKs and iOS IPAs from your project's source code." },
      { property: "og:description", content: "Cloud Build Buddy is a mobile app that builds Android APKs and iOS IPAs from your project's source code." },
      { name: "twitter:description", content: "Cloud Build Buddy is a mobile app that builds Android APKs and iOS IPAs from your project's source code." },
      { property: "og:image", content: "https://storage.googleapis.com/gpt-engineer-file-uploads/A9RxqPBqL9fVOYBnaryB3pDEz1D3/social-images/social-1783592217253-165268.webp" },
      { name: "twitter:image", content: "https://storage.googleapis.com/gpt-engineer-file-uploads/A9RxqPBqL9fVOYBnaryB3pDEz1D3/social-images/social-1783592217253-165268.webp" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  useEffect(() => {
    // Cross-tab auth-state sync is a non-critical enhancement. If Supabase
    // isn't configured in this environment (e.g. VITE_SUPABASE_URL /
    // VITE_SUPABASE_PUBLISHABLE_KEY missing from the deployed build), the
    // `supabase` proxy throws the moment `.auth` is accessed. Because this
    // effect runs on every route via the shared root layout, an unguarded
    // throw here previously took down every single page in the app. Fail
    // soft instead: log it, report it, and let the rest of the app render.
    let unsubscribe: (() => void) | undefined;
    try {
      const { data } = supabase.auth.onAuthStateChange((event) => {
        if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
        router.invalidate();
        if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
      });
      unsubscribe = () => data.subscription.unsubscribe();
    } catch (error) {
      console.error("[supabase] auth state sync unavailable:", error);
      reportLovableError(error, { boundary: "root_auth_state_sync" });
    }
    return () => unsubscribe?.();
  }, [router, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <Toaster richColors position="top-center" />
    </QueryClientProvider>
  );
}
