-- Revoke inherited Supabase Data API table grants from public client roles.
-- AgentGuard accesses these tables only through authenticated server-side RPCs
-- using the service_role credential. RLS remains enabled as defense in depth.
REVOKE ALL ON TABLE
  public.agents,
  public.agent_budgets,
  public.spend_reservations
FROM PUBLIC, anon, authenticated;
