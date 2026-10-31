-- Rollback-only verification for AgentGuard's shared-budget RPC.
-- Run in the Supabase SQL Editor after applying the current schema/migrations.
-- No real transfer is made. All inserted rows and budget changes are rolled back.
--
-- This verifies single-session behavior only. It does NOT prove concurrent
-- requests are serialized; that requires a separate two-session test.

begin;

do $$
declare
  v_agent_id text := 'ag_probe_' || substr(md5(clock_timestamp()::text), 1, 12);
  v_request_id text := 'agentguard-probe-' || substr(md5(random()::text), 1, 16);
  v_blocked_id text := 'agentguard-block-' || substr(md5(random()::text), 1, 16);
  v_amount numeric := 123;
  v_before public.agent_budgets%rowtype;
  v_after public.agent_budgets%rowtype;
  v_result jsonb;
begin
  select * into v_before
  from public.agent_budgets
  where id = 'default'
  for update;

  if not found then
    raise exception 'verification_failed: default budget row missing';
  end if;

  insert into public.agents (id, name, active)
  values (v_agent_id, 'Temporary RPC verification agent', true);

  -- First request must create one reservation.
  v_result := public.reserve_agent_spend(
    v_request_id, v_amount, 'probe.testnet', v_agent_id
  );

  if v_result->>'created' <> 'true' or v_result->>'status' <> 'reserved' then
    raise exception 'verification_failed: first reservation was not created: %', v_result;
  end if;

  select * into v_after
  from public.agent_budgets
  where id = 'default';

  if v_after.reserved_yocto <> v_before.reserved_yocto + v_amount then
    raise exception 'verification_failed: shared reserved balance did not increase exactly once';
  end if;

  -- Exact replay must return the existing reservation without reserving again.
  v_result := public.reserve_agent_spend(
    v_request_id, v_amount, 'probe.testnet', v_agent_id
  );

  if v_result->>'created' <> 'false' then
    raise exception 'verification_failed: replay created another reservation: %', v_result;
  end if;

  select * into v_after
  from public.agent_budgets
  where id = 'default';

  if v_after.reserved_yocto <> v_before.reserved_yocto + v_amount then
    raise exception 'verification_failed: replay changed the reserved balance';
  end if;

  -- Reusing the same key with a different amount must raise the conflict.
  begin
    perform public.reserve_agent_spend(
      v_request_id, v_amount + 1, 'probe.testnet', v_agent_id
    );
    raise exception 'verification_failed: idempotency conflict was not rejected';
  exception
    when raise_exception then
      if sqlerrm <> 'idempotency_key_conflict' then
        raise;
      end if;
  end;

  -- Set the limit to the current committed+reserved total inside this
  -- transaction. A further positive reservation must be blocked.
  update public.agent_budgets
  set total_limit_yocto = spent_yocto + reserved_yocto
  where id = 'default';

  v_result := public.reserve_agent_spend(
    v_blocked_id, 1, 'probe.testnet', v_agent_id
  );

  if v_result->>'status' <> 'blocked' then
    raise exception 'verification_failed: shared budget overrun was not blocked: %', v_result;
  end if;

  -- Restore the original limit before settlement checks.
  update public.agent_budgets
  set total_limit_yocto = v_before.total_limit_yocto
  where id = 'default';

  -- needs_review must keep funds reserved.
  perform public.finish_agent_spend(v_request_id, 'needs_review', null, 'verification probe');

  select * into v_after
  from public.agent_budgets
  where id = 'default';

  if v_after.reserved_yocto <> v_before.reserved_yocto + v_amount then
    raise exception 'verification_failed: needs_review released reserved funds';
  end if;

  -- Executed must move the amount from reserved to spent.
  perform public.finish_agent_spend(v_request_id, 'executed', 'verification-only-hash', null);

  select * into v_after
  from public.agent_budgets
  where id = 'default';

  if v_after.reserved_yocto <> v_before.reserved_yocto
     or v_after.spent_yocto <> v_before.spent_yocto + v_amount then
    raise exception 'verification_failed: executed settlement did not move balances exactly';
  end if;

  -- A second settlement attempt must not change a terminal reservation.
  perform public.finish_agent_spend(v_request_id, 'failed', null, 'duplicate settlement probe');

  select * into v_after
  from public.agent_budgets
  where id = 'default';

  if v_after.reserved_yocto <> v_before.reserved_yocto
     or v_after.spent_yocto <> v_before.spent_yocto + v_amount then
    raise exception 'verification_failed: terminal reservation was settled twice';
  end if;
end;
$$;

rollback;

-- If the script reaches this line without an exception, the checks passed.
-- The ROLLBACK removes the temporary agent, reservation, and balance changes.
