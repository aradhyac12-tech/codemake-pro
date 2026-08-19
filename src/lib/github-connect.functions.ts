import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const connectGithub = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { token: string }) =>
    z.object({ token: z.string().min(1).max(500) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const probe = await (await import("./github-token.server")).probeGithubToken(data.token);

    const { error } = await supabase.from("github_connections").upsert({
      user_id: userId,
      github_login: probe.login,
      access_token: data.token.trim(),
      token_type: probe.tokenType,
      scopes: probe.scopes.join(","),
      validated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`Saved token validation passed but storing it failed: ${error.message}`);

    return { login: probe.login, tokenType: probe.tokenType, notes: probe.notes };
  });

export const disconnectGithub = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("github_connections").delete().eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });