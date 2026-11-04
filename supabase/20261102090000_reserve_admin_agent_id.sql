-- Reserve the administrator audit identity so no agent can impersonate it.
-- Fail closed if the identifier is already in use; do not rewrite existing identities.
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agents WHERE id = 'admin') THEN
    RAISE EXCEPTION 'reserved_agent_id_admin_already_exists';
  END IF;
END
$migration$;

ALTER TABLE public.agents
  ADD CONSTRAINT agents_reserved_admin_id_check
  CHECK (id <> 'admin');
