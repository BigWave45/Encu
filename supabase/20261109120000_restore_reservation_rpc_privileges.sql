-- Restore the privileged reservation RPC execution model.
--
-- reserve_agent_spend performs atomic treasury/allocation locking and ledger writes.
-- The backend service_role is the only caller; it must not receive direct UPDATE
-- access to agent_allocations merely to make this RPC work.
--
-- The function body uses schema-qualified object references and a fixed empty
-- search_path. It contains no dynamic SQL.

begin;

alter function public.reserve_agent_spend(text, numeric, text, text)
  security definer;

revoke all on function public.reserve_agent_spend(text, numeric, text, text)
  from public, anon, authenticated;

grant execute on function public.reserve_agent_spend(text, numeric, text, text)
  to service_role;

commit;
