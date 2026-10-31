-- AgentGuard multi-agent V1 cleanup.
-- Apply after multi-agent-v1-migration.sql. Removes the legacy single-agent
-- RPC signature so all reservations must include an authenticated agent ID.

drop function if exists public.reserve_agent_spend(text, numeric, text);

revoke all on function public.reserve_agent_spend(text, numeric, text, text) from public;
grant execute on function public.reserve_agent_spend(text, numeric, text, text) to service_role;
