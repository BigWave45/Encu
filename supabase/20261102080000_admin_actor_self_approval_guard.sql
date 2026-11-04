-- Forward-only correction: administrator identity must be distinct from agent identity.
-- The admin credential uses the reserved audit actor ID "admin", never "primary".
create or replace function public.approve_agent_transfer(p_request_id text,p_actor_agent_id text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_reservation public.spend_reservations%rowtype;
  v_policy public.agent_policies%rowtype;
  v_enabled boolean; v_active boolean; v_daily numeric; v_weekly numeric;
begin
  if p_actor_agent_id is null or p_actor_agent_id = 'system:outlayer' then
    raise exception 'invalid_approval_actor';
  end if;
  perform 1 from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select * into v_reservation from public.spend_reservations where request_id=p_request_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if p_actor_agent_id = v_reservation.agent_id then
    raise exception 'self_approval_forbidden';
  end if;
  if v_reservation.status<>'awaiting_approval' or v_reservation.submission_claimed_at is not null then
    raise exception 'approval_not_pending';
  end if;
  if v_reservation.approval_expires_at is null or v_reservation.approval_expires_at<=pg_catalog.now() then
    raise exception 'approval_expired';
  end if;
  select transfers_enabled into v_enabled from public.agentguard_system_controls where id='default' for share;
  if not coalesce(v_enabled,false) then
    insert into public.agentguard_security_events(actor_agent_id,event_type,request_id,details)
    values(v_reservation.agent_id,'transfer_approval_blocked_emergency_stop',p_request_id,
      pg_catalog.jsonb_build_object('recipient',v_reservation.recipient,'amount_yocto',v_reservation.amount_yocto::text));
    return pg_catalog.jsonb_build_object('approved',false,'reason','emergency_stop','request_id',p_request_id);
  end if;
  select active into v_active from public.agents where id=v_reservation.agent_id for share;
  if not coalesce(v_active,false) then raise exception 'agent_not_active'; end if;
  select * into v_policy from public.agent_policies where agent_id=v_reservation.agent_id for share;
  if not found then raise exception 'agent_policy_not_configured'; end if;
  if v_policy.max_transfer_yocto is not null and v_reservation.amount_yocto>v_policy.max_transfer_yocto then
    raise exception 'agent_per_transfer_limit';
  end if;
  if v_policy.allowed_recipients is not null and not (v_reservation.recipient=any(v_policy.allowed_recipients)) then
    raise exception 'recipient_not_allowed';
  end if;
  if v_policy.daily_limit_yocto is not null then
    select coalesce(sum(amount_yocto),0) into v_daily from public.spend_reservations
    where agent_id=v_reservation.agent_id and created_at>=pg_catalog.now()-interval '24 hours'
      and status in ('awaiting_approval','reserved','needs_review','executed');
    if v_daily>v_policy.daily_limit_yocto then raise exception 'agent_daily_limit'; end if;
  end if;
  if v_policy.weekly_limit_yocto is not null then
    select coalesce(sum(amount_yocto),0) into v_weekly from public.spend_reservations
    where agent_id=v_reservation.agent_id and created_at>=pg_catalog.now()-interval '7 days'
      and status in ('awaiting_approval','reserved','needs_review','executed');
    if v_weekly>v_policy.weekly_limit_yocto then raise exception 'agent_weekly_limit'; end if;
  end if;
  update public.spend_reservations set status='reserved',approved_at=pg_catalog.now(),
    approved_by=p_actor_agent_id,submission_claimed_at=pg_catalog.now(),updated_at=pg_catalog.now()
    where request_id=p_request_id;
  insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
  values(p_actor_agent_id,'transfer_approved',p_request_id,
    pg_catalog.jsonb_build_object('agent_id',v_reservation.agent_id,'recipient',v_reservation.recipient,
      'amount_yocto',v_reservation.amount_yocto::text));
  return pg_catalog.jsonb_build_object('request_id',p_request_id,'agent_id',v_reservation.agent_id,
    'recipient',v_reservation.recipient,'amount_yocto',v_reservation.amount_yocto::text,'status','reserved');
end;
$$;
revoke all on function public.approve_agent_transfer(text,text) from public,anon,authenticated;
grant execute on function public.approve_agent_transfer(text,text) to service_role;
