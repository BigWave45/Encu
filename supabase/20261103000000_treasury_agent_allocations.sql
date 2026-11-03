-- Diagnostic probe only; do not apply.
create or replace function public.agentguard_probe() returns integer language sql security definer set search_path='' as $$ select 1 $$;
