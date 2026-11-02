-- Revoke inherited Supabase Data API table grants from public client roles.
-- AgentGuard accesses these tables only through authenticated server-side RPCs
-- using the service_role credential. RLS remains enabled as defense in depth.
REVOKE ALL ON TABLE
  public.agents,
  public.agent_budgets,
  public.spend_reservations
FROM PUBLIC, anon, authenticated;

-- The trusted backend still needs direct reads for the admin dashboard.
GRANT SELECT ON TABLE
  public.agents,
  public.agent_budgets,
  public.spend_reservations
TO service_role;
