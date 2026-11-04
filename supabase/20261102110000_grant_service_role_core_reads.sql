-- Explicitly preserve the trusted backend's direct read access to core ledger
-- tables. Public client roles remain revoked by the preceding migration.
GRANT SELECT ON TABLE
  public.agents,
  public.agent_budgets,
  public.spend_reservations
TO service_role;
