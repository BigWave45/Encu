-- Restrict AgentGuard's privileged RPCs and internal tables to server-side access.
-- The Next.js API uses SUPABASE_SERVICE_ROLE_KEY (lib/supabase.ts).
-- Do not grant these functions to anon/authenticated: they do not authenticate
-- the AgentGuard Bearer token themselves.

revoke execute on function public.reserve_agent_spend(text, numeric, text, text)
  from public, anon, authenticated;
grant execute on function public.reserve_agent_spend(text, numeric, text, text)
  to service_role;

revoke execute on function public.finish_agent_spend(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.finish_agent_spend(text, text, text, text)
  to service_role;

-- These tables are accessed only by the trusted server-side service-role client.
revoke all privileges on table public.agents, public.agent_budgets, public.spend_reservations
  from anon, authenticated;

-- Fail closed for future objects created by postgres in public.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

revoke execute on function public.record_outlayer_submission(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_outlayer_submission(text, text, text, text)
  to service_role;


revoke execute on function public.record_outlayer_submission(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_outlayer_submission(text, text, text, text)
  to service_role;
