-- Diagnostic probe only; do not apply.
create or replace function public.agentguard_probe() returns integer language sql immutable as $$ select 1 $$;
