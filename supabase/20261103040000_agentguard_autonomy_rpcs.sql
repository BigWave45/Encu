-- Install the AgentGuard autonomy RPCs.
-- These functions execute as the caller; the API uses the server-only service_role.
create or replace function public.set_agent_auto_spend_limit(
  p_agent_id text,
  p_auto_spend_limit_yocto numeric,
  p_actor_agent_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allocation public.agent_allocations%rowtype;
  v_current numeric;
  v_policy public.agent_policies%rowtype;
begin
  if p_agent_id is null or p_actor_agent_id is null
    or (p_auto_spend_limit_yocto is not null and (
      p_auto_spend_limit_yocto < 0
      or p_auto_spend_limit_yocto >= 1e78
      or p_auto_spend_limit_yocto <> pg_catalog.trunc(p_auto_spend_limit_yocto)
    )) then
    raise exception 'invalid_auto_spend_limit';
  end if;

  perform 1 from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  select * into v_allocation
  from public.agent_allocations where agent_id = p_agent_id for update;
  if not found then raise exception 'agent_allocation_not_configured'; end if;

  select coalesce(sum(amount_yocto), 0) into v_current
  from public.spend_reservations
  where agent_id = p_agent_id
    and auto_approved = true
    and status in ('reserved', 'needs_review', 'executed');

  if p_auto_spend_limit_yocto is not null and p_auto_spend_limit_yocto < v_current then
    raise exception 'auto_limit_below_committed_amounts';
  end if;
  if p_auto_spend_limit_yocto is not null and p_auto_spend_limit_yocto > v_allocation.allocation_limit_yocto then
    raise exception 'auto_limit_exceeds_agent_allocation';
  end if;

  update public.agent_policies
  set auto_spend_limit_yocto = p_auto_spend_limit_yocto,
      updated_at = pg_catalog.now(),
      updated_by = p_actor_agent_id
  where agent_id = p_agent_id
  returning * into v_policy;
  if not found then raise exception 'agent_policy_not_configured'; end if;

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values(p_actor_agent_id, 'agent_auto_spend_limit_updated', p_agent_id,
    pg_catalog.jsonb_build_object(
      'auto_spend_limit_yocto', v_policy.auto_spend_limit_yocto::text,
      'auto_spent_or_reserved_yocto', v_current::text
    ));

  return pg_catalog.jsonb_build_object(
    'agent_id', p_agent_id,
    'auto_spend_limit_yocto', v_policy.auto_spend_limit_yocto::text,
    'auto_spent_or_reserved_yocto', v_current::text
  );
end;
$$;

create or replace function public.reserve_agent_spend(
  p_request_id text, p_amount_yocto numeric, p_recipient text, p_agent_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_budget public.agent_budgets%rowtype;
  v_allocation public.agent_allocations%rowtype;
  v_existing public.spend_reservations%rowtype;
  v_policy public.agent_policies%rowtype;
  v_recipient_auth public.agent_authorized_recipients%rowtype;
  v_active boolean;
  v_enabled boolean;
  v_daily numeric;
  v_weekly numeric;
  v_auto_committed numeric;
  v_auto boolean := false;
  v_status text;
  v_expiry timestamptz;
begin
  if p_request_id is null or pg_catalog.length(p_request_id) < 8 then
    raise exception 'invalid_request_id';
  end if;
  if p_amount_yocto is null or p_amount_yocto <= 0 or p_amount_yocto >= 1e78
    or p_amount_yocto <> pg_catalog.trunc(p_amount_yocto) then
    raise exception 'invalid_amount';
  end if;
  if p_recipient is null or pg_catalog.length(p_recipient) < 2 or pg_catalog.length(p_recipient) > 64
    or p_recipient !~ ('^[a-z0-9]+([._-][a-z0-9]+)*' || chr(36)) then
    raise exception 'invalid_recipient';
  end if;

  select * into v_budget from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select * into v_allocation from public.agent_allocations where agent_id = p_agent_id for update;
  if not found then raise exception 'agent_allocation_not_configured'; end if;
  select active into v_active from public.agents where id = p_agent_id for share;
  if not coalesce(v_active, false) then raise exception 'agent_not_active'; end if;

  select * into v_existing from public.spend_reservations where request_id = p_request_id for update;
  if found then
    if v_existing.amount_yocto <> p_amount_yocto or v_existing.recipient <> p_recipient or v_existing.agent_id <> p_agent_id then
      raise exception 'idempotency_key_conflict';
    end if;
    return pg_catalog.jsonb_build_object(
      'created', false, 'status', v_existing.status, 'request_id', p_request_id,
      'agent_id', p_agent_id, 'auto_approved', v_existing.auto_approved
    );
  end if;

  select transfers_enabled into v_enabled
  from public.agentguard_system_controls where id = 'default' for share;
  if not coalesce(v_enabled, false) then
    insert into public.agentguard_security_events(actor_agent_id, event_type, request_id, details)
    values(p_agent_id, 'transfer_emergency_stop_blocked', p_request_id,
      pg_catalog.jsonb_build_object('amount_yocto', p_amount_yocto::text, 'recipient', p_recipient));
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'emergency_stop');
  end if;

  select * into v_policy from public.agent_policies where agent_id = p_agent_id for share;
  if not found then raise exception 'agent_policy_not_configured'; end if;

  if v_policy.max_transfer_yocto is not null and p_amount_yocto > v_policy.max_transfer_yocto then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_per_transfer_limit');
  end if;
  if v_policy.allowed_recipients is not null and not (p_recipient = any(v_policy.allowed_recipients)) then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'recipient_not_allowed');
  end if;

  select * into v_recipient_auth
  from public.agent_authorized_recipients
  where agent_id = p_agent_id and account_id = p_recipient
    and status = 'active' and (expires_at is null or expires_at > pg_catalog.now())
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'recipient_not_authorized');
  end if;

  if v_policy.daily_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_daily
    from public.spend_reservations
    where agent_id = p_agent_id and created_at >= pg_catalog.now() - interval '24 hours'
      and status in ('awaiting_approval', 'reserved', 'needs_review', 'executed');
    if v_daily + p_amount_yocto > v_policy.daily_limit_yocto then
      return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_daily_limit');
    end if;
  end if;

  if v_policy.weekly_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_weekly
    from public.spend_reservations
    where agent_id = p_agent_id and created_at >= pg_catalog.now() - interval '7 days'
      and status in ('awaiting_approval', 'reserved', 'needs_review', 'executed');
    if v_weekly + p_amount_yocto > v_policy.weekly_limit_yocto then
      return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_weekly_limit');
    end if;
  end if;

  if v_allocation.spent_yocto + v_allocation.reserved_yocto + p_amount_yocto > v_allocation.allocation_limit_yocto then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_allocation_exceeded');
  end if;
  if v_budget.spent_yocto + v_budget.reserved_yocto + p_amount_yocto > v_budget.total_limit_yocto then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'total_budget_exceeded');
  end if;

  if v_policy.auto_spend_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_auto_committed
    from public.spend_reservations
    where agent_id = p_agent_id and auto_approved = true
      and status in ('reserved', 'needs_review', 'executed');
    v_auto := v_auto_committed + p_amount_yocto <= v_policy.auto_spend_limit_yocto;
  end if;

  if v_auto then
    v_status := 'reserved';
    v_expiry := null;
  else
    v_status := 'awaiting_approval';
    v_expiry := pg_catalog.now() + interval '15 minutes';
  end if;

  insert into public.spend_reservations(
    request_id, amount_yocto, recipient, status, agent_id,
    approval_expires_at, auto_approved, submission_claimed_at
  ) values (
    p_request_id, p_amount_yocto, p_recipient, v_status, p_agent_id,
    v_expiry, v_auto, case when v_auto then pg_catalog.now() else null end
  );

  update public.agent_budgets
  set reserved_yocto = reserved_yocto + p_amount_yocto, updated_at = pg_catalog.now()
  where id = 'default';
  update public.agent_allocations
  set reserved_yocto = reserved_yocto + p_amount_yocto, updated_at = pg_catalog.now()
  where agent_id = p_agent_id;

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values(p_agent_id, case when v_auto then 'transfer_auto_authorized' else 'transfer_submitted_for_approval' end,
    p_request_id, pg_catalog.jsonb_build_object(
      'recipient', p_recipient, 'amount_yocto', p_amount_yocto::text,
      'auto_approved', v_auto, 'auto_spend_limit_yocto', v_policy.auto_spend_limit_yocto::text
    ));

  return pg_catalog.jsonb_build_object(
    'created', true, 'status', v_status, 'request_id', p_request_id,
    'agent_id', p_agent_id, 'auto_approved', v_auto, 'approval_expires_at', v_expiry
  );
end;
$$;

revoke all on function public.set_agent_auto_spend_limit(text,numeric,text) from public, anon, authenticated;
grant execute on function public.set_agent_auto_spend_limit(text,numeric,text) to service_role;
