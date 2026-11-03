-- Revalidate current agent policy at the atomic autonomous-submission boundary.
-- If an already-reserved autonomous request no longer fits current policy, move
-- it to the administrator approval queue instead of submitting stale authority.

create or replace function public.claim_agent_auto_submission(
  p_request_id text,
  p_agent_id text,
  p_recipient text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allocation public.agent_allocations%rowtype;
  v_policy public.agent_policies%rowtype;
  v_recipient public.agent_authorized_recipients%rowtype;
  v_reservation public.spend_reservations%rowtype;
  v_enabled boolean;
  v_active boolean;
  v_daily numeric;
  v_weekly numeric;
  v_policy_reason text;
  v_approval_expires_at timestamptz;
begin
  if p_request_id is null or p_agent_id is null or p_recipient is null then
    raise exception 'invalid_submission_claim';
  end if;

  -- All policy mutations and spend reservations serialize on the treasury row.
  perform 1 from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  select * into v_allocation
  from public.agent_allocations
  where agent_id = p_agent_id
  for update;
  if not found then raise exception 'agent_allocation_not_configured'; end if;

  select * into v_policy
  from public.agent_policies
  where agent_id = p_agent_id
  for share;
  if not found then raise exception 'agent_policy_not_configured'; end if;

  select * into v_recipient
  from public.agent_authorized_recipients
  where agent_id = p_agent_id and account_id = p_recipient
  for update;
  if not found or v_recipient.status <> 'active'
     or (v_recipient.expires_at is not null and v_recipient.expires_at <= pg_catalog.now()) then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'recipient_not_authorized');
  end if;

  select * into v_reservation
  from public.spend_reservations
  where request_id = p_request_id
  for update;
  if not found or v_reservation.agent_id <> p_agent_id
     or v_reservation.recipient <> p_recipient
     or v_reservation.status <> 'reserved'
     or v_reservation.auto_approved is distinct from true then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'reservation_not_claimable');
  end if;

  if v_reservation.submission_claimed_at is not null then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'already_claimed');
  end if;

  select transfers_enabled into v_enabled
  from public.agentguard_system_controls
  where id = 'default'
  for share;

  select active into v_active
  from public.agents
  where id = p_agent_id
  for share;

  -- The request was authorized when reserved. Re-evaluate mutable controls
  -- immediately before submission. The treasury lock makes this check atomic
  -- against policy, recipient, agent and emergency-stop changes.
  if v_policy.max_transfer_yocto is not null
     and v_reservation.amount_yocto > v_policy.max_transfer_yocto then
    v_policy_reason := 'agent_per_transfer_limit';
  elsif v_policy.allowed_recipients is not null
     and not (p_recipient = any(v_policy.allowed_recipients)) then
    v_policy_reason := 'recipient_not_allowed';
  elsif v_policy.daily_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_daily
    from public.spend_reservations
    where agent_id = p_agent_id
      and created_at >= pg_catalog.now() - interval '24 hours'
      and status in ('awaiting_approval', 'reserved', 'needs_review', 'executed');
    if v_daily > v_policy.daily_limit_yocto then
      v_policy_reason := 'agent_daily_limit';
    end if;
  end if;

  if v_policy_reason is null and v_policy.weekly_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_weekly
    from public.spend_reservations
    where agent_id = p_agent_id
      and created_at >= pg_catalog.now() - interval '7 days'
      and status in ('awaiting_approval', 'reserved', 'needs_review', 'executed');
    if v_weekly > v_policy.weekly_limit_yocto then
      v_policy_reason := 'agent_weekly_limit';
    end if;
  end if;

  if v_policy_reason is not null or not coalesce(v_enabled, false) or not coalesce(v_active, false) then
    v_approval_expires_at := pg_catalog.now() + interval '15 minutes';
    update public.spend_reservations
    set status = 'awaiting_approval',
        auto_approved = false,
        approval_expires_at = v_approval_expires_at,
        submission_claimed_at = null,
        updated_at = pg_catalog.now()
    where request_id = p_request_id;

    insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
    values(p_agent_id, 'transfer_auto_authorization_downgraded', p_request_id,
      pg_catalog.jsonb_build_object(
        'reason', coalesce(v_policy_reason,
          case when not coalesce(v_enabled, false) then 'emergency_stop' else 'agent_not_active' end),
        'approval_expires_at', v_approval_expires_at
      ));

    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'reason', coalesce(v_policy_reason,
        case when not coalesce(v_enabled, false) then 'emergency_stop' else 'agent_not_active' end),
      'awaiting_approval', true,
      'approval_expires_at', v_approval_expires_at,
      'request_id', p_request_id
    );
  end if;

  update public.spend_reservations
  set submission_claimed_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where request_id = p_request_id;

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values(p_agent_id, 'transfer_submission_claimed', p_request_id,
    pg_catalog.jsonb_build_object('recipient', p_recipient, 'amount_yocto', v_reservation.amount_yocto::text));

  return pg_catalog.jsonb_build_object('claimed', true, 'request_id', p_request_id);
end;
$$;

revoke all on function public.claim_agent_auto_submission(text,text,text) from public, anon, authenticated;
grant execute on function public.claim_agent_auto_submission(text,text,text) to service_role;
