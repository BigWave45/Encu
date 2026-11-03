-- Revalidate the complete financial policy at the atomic provider-submission boundary.
-- A request reserved under an older policy must be blocked if policy changed before submission.
create or replace function public.claim_agent_auto_submission(
  p_request_id text,
  p_agent_id text,
  p_recipient text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_budget public.agent_budgets%rowtype;
  v_allocation public.agent_allocations%rowtype;
  v_recipient public.agent_authorized_recipients%rowtype;
  v_reservation public.spend_reservations%rowtype;
  v_policy public.agent_policies%rowtype;
  v_enabled boolean;
  v_active boolean;
  v_daily numeric;
  v_weekly numeric;
  v_auto_committed numeric;
begin
  if p_request_id is null or p_agent_id is null or p_recipient is null then
    raise exception 'invalid_submission_claim';
  end if;

  select * into v_budget from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  select * into v_allocation from public.agent_allocations
  where agent_id = p_agent_id for update;
  if not found then raise exception 'agent_allocation_not_configured'; end if;

  select * into v_recipient from public.agent_authorized_recipients
  where agent_id = p_agent_id and account_id = p_recipient for update;
  if not found or v_recipient.status <> 'active'
     or (v_recipient.expires_at is not null and v_recipient.expires_at <= pg_catalog.now()) then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'recipient_not_authorized');
  end if;

  select * into v_reservation from public.spend_reservations
  where request_id = p_request_id for update;
  if not found or v_reservation.agent_id <> p_agent_id
     or v_reservation.recipient <> p_recipient
     or v_reservation.status <> 'reserved'
     or v_reservation.auto_approved is distinct from true then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'reservation_not_claimable');
  end if;
  if v_reservation.submission_claimed_at is not null then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'already_claimed');
  end if;

  select transfers_enabled into v_enabled from public.agentguard_system_controls
  where id = 'default' for share;
  if not coalesce(v_enabled, false) then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'emergency_stop');
  end if;

  select active into v_active from public.agents where id = p_agent_id for share;
  if not coalesce(v_active, false) then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'agent_not_active');
  end if;

  select * into v_policy from public.agent_policies where agent_id = p_agent_id for share;
  if not found then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'agent_policy_not_configured');
  end if;

  if v_policy.max_transfer_yocto is not null
     and v_reservation.amount_yocto > v_policy.max_transfer_yocto then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'agent_per_transfer_limit');
  end if;
  if v_policy.allowed_recipients is not null
     and not (p_recipient = any(v_policy.allowed_recipients)) then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'recipient_not_allowed');
  end if;

  if v_policy.daily_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_daily
    from public.spend_reservations
    where agent_id = p_agent_id and request_id <> p_request_id
      and created_at >= pg_catalog.now() - interval '24 hours'
      and status in ('awaiting_approval', 'reserved', 'needs_review', 'executed');
    if v_daily + v_reservation.amount_yocto > v_policy.daily_limit_yocto then
      return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'agent_daily_limit');
    end if;
  end if;

  if v_policy.weekly_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_weekly
    from public.spend_reservations
    where agent_id = p_agent_id and request_id <> p_request_id
      and created_at >= pg_catalog.now() - interval '7 days'
      and status in ('awaiting_approval', 'reserved', 'needs_review', 'executed');
    if v_weekly + v_reservation.amount_yocto > v_policy.weekly_limit_yocto then
      return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'agent_weekly_limit');
    end if;
  end if;

  if v_allocation.spent_yocto + v_allocation.reserved_yocto > v_allocation.allocation_limit_yocto then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'agent_allocation_exceeded');
  end if;
  if v_budget.spent_yocto + v_budget.reserved_yocto > v_budget.total_limit_yocto then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'total_budget_exceeded');
  end if;

  select coalesce(sum(amount_yocto), 0) into v_auto_committed
  from public.spend_reservations
  where agent_id = p_agent_id and request_id <> p_request_id
    and auto_approved = true and status in ('reserved', 'needs_review', 'executed');
  if v_policy.auto_spend_limit_yocto is null
     or v_auto_committed + v_reservation.amount_yocto > v_policy.auto_spend_limit_yocto then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'autonomous_allowance_exceeded');
  end if;

  update public.spend_reservations set submission_claimed_at = pg_catalog.now(),
    updated_at = pg_catalog.now() where request_id = p_request_id;
  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values(p_agent_id, 'transfer_submission_claimed', p_request_id,
    pg_catalog.jsonb_build_object('recipient', p_recipient, 'amount_yocto', v_reservation.amount_yocto::text));
  return pg_catalog.jsonb_build_object('claimed', true, 'request_id', p_request_id);
end;
$function$;

revoke all on function public.claim_agent_auto_submission(text,text,text) from public, anon, authenticated;
grant execute on function public.claim_agent_auto_submission(text,text,text) to service_role;
