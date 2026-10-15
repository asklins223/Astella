-- Native clients report their own platform; the server continues to enforce scope/RLS.
ALTER TABLE public.companion_awareness_sessions
  DROP CONSTRAINT IF EXISTS companion_awareness_sessions_host_check;
--> statement-breakpoint
ALTER TABLE public.companion_awareness_sessions
  ADD CONSTRAINT companion_awareness_sessions_host_check CHECK (host IN ('desktop','browser','ios','android'));
