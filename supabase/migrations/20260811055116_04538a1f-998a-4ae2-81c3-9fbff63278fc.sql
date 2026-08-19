ALTER TABLE public.github_connections
  ADD COLUMN IF NOT EXISTS token_type text,
  ADD COLUMN IF NOT EXISTS scopes text,
  ADD COLUMN IF NOT EXISTS validated_at timestamptz;

ALTER TABLE public.builds
  ADD COLUMN IF NOT EXISTS stage_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS retry_of uuid REFERENCES public.builds(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS artifact_kind text;

CREATE INDEX IF NOT EXISTS builds_created_at_idx ON public.builds (created_at);
CREATE INDEX IF NOT EXISTS builds_status_idx ON public.builds (status);

CREATE OR REPLACE FUNCTION public.touch_build_stage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.stage IS DISTINCT FROM OLD.stage THEN
    NEW.stage_updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builds_touch_stage ON public.builds;
CREATE TRIGGER builds_touch_stage
BEFORE UPDATE ON public.builds
FOR EACH ROW EXECUTE FUNCTION public.touch_build_stage();