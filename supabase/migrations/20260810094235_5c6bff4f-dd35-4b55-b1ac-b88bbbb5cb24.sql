CREATE TABLE public.github_connections (
  user_id UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  github_login TEXT NOT NULL,
  access_token TEXT NOT NULL,
  repo_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.github_connections TO authenticated;
GRANT ALL ON public.github_connections TO service_role;
ALTER TABLE public.github_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own github connection" ON public.github_connections
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.keystores (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  keystore_base64 TEXT NOT NULL,
  key_alias TEXT NOT NULL,
  keystore_password TEXT NOT NULL,
  key_password TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.keystores TO authenticated;
GRANT ALL ON public.keystores TO service_role;
ALTER TABLE public.keystores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own keystores" ON public.keystores
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX keystores_user_idx ON public.keystores(user_id);

CREATE TABLE public.builds (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  stage TEXT NOT NULL DEFAULT 'QUEUED',
  platform TEXT NOT NULL DEFAULT 'android',
  keystore_id UUID REFERENCES public.keystores(id) ON DELETE SET NULL,
  source_filename TEXT,
  source_size BIGINT,
  repo TEXT,
  branch TEXT,
  github_run_id BIGINT,
  artifact_path TEXT,
  source_path TEXT,
  error_summary TEXT,
  error_category TEXT,
  error_retriable BOOLEAN,
  diagnostics JSONB,
  codemagic_build_id TEXT,
  project_kind TEXT,
  web_dir TEXT,
  app_name TEXT,
  bundle_id TEXT,
  logo_path TEXT,
  node_version TEXT NOT NULL DEFAULT '22',
  diagnostic_token TEXT,
  release_type TEXT NOT NULL DEFAULT 'release',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.builds TO authenticated;
GRANT ALL ON public.builds TO service_role;
ALTER TABLE public.builds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own builds" ON public.builds
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX builds_user_idx ON public.builds(user_id, created_at DESC);
CREATE INDEX builds_diagnostic_token_idx ON public.builds (diagnostic_token) WHERE diagnostic_token IS NOT NULL;

CREATE TABLE public.build_logs (
  id BIGSERIAL PRIMARY KEY,
  build_id UUID NOT NULL REFERENCES public.builds(id) ON DELETE CASCADE,
  chunk TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.build_logs TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.build_logs_id_seq TO authenticated;
GRANT ALL ON public.build_logs TO service_role;
GRANT ALL ON SEQUENCE public.build_logs_id_seq TO service_role;
ALTER TABLE public.build_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read own build logs" ON public.build_logs
  FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.builds b WHERE b.id = build_logs.build_id AND b.user_id = auth.uid()));
CREATE INDEX build_logs_build_idx ON public.build_logs(build_id, id);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$
LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_builds_updated_at BEFORE UPDATE ON public.builds
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE POLICY "users manage own build-sources"
ON storage.objects FOR ALL TO authenticated
USING (bucket_id = 'build-sources' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'build-sources' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "users read own build-artifacts"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'build-artifacts' AND (storage.foldername(name))[1] = auth.uid()::text);