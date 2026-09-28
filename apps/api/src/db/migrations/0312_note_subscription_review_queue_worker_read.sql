-- The shared due-review predicate now reads active note subscriptions so the
-- worker's companion count and the API queue use the same no-card target gate.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT ON public.review_subscriptions_v2 TO ailearn_worker;
  END IF;
END $$;
