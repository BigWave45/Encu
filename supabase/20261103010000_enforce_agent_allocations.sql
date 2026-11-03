-- Phase 2: enforce agent allocations across every reservation lifecycle path.
-- Requires 20261103000000_treasury_agent_allocations.sql.
-- Lock order for all mutating paths: treasury -> agent allocation -> reservation.
begin;

-- Phase 1 is deliberately additive so old application instances can continue
-- running between migrations. Reconcile again under the treasury row lock here
-- before replacing any RPC, covering reservations/agents created in that gap.
do $allocation_reconcile$
declare
  v_budget public.agent_budgets%rowtype;
  v_spent numeric;
  v_reserved numeric;
  v_unknown bigint;
  v_allocated numeric;
begin
  select * into v_budget from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  insert into public.agent_allocations(agent_id,allocation_limit_yocto,spent_yocto,reserved_yocto)
  select a.id,0,0,0 from public.agents a
  where not exists (select 1 from public.agent_allocations aa where aa.agent_id=a.id);

  select
    coalesce(sum(amount_yocto) filter(where status='executed'),0),
    coalesce(sum(amount_yocto) filter(where status in ('awaiting_approval','reserved','needs_review')),0),
    count(*) filter(where status not in ('awaiting_approval','reserved','needs_review','executed','failed','rejected','cancelled'))
  into v_spent,v_reserved,v_unknown
  from public.spend_reservations;

  if v_unknown<>0 then raise exception 'allocation_reconcile_unknown_reservation_statuses: %',v_unknown; end if;
  if v_spent<>v_budget.spent_yocto or v_reserved<>v_budget.reserved_yocto then
    raise exception 'allocation_reconcile_treasury_ledger_mismatch';
  end if;

  update public.agent_allocations aa
  set spent_yocto=coalesce(r.spent,0),
      reserved_yocto=coalesce(r.reserved,0),
      allocation_limit_yocto=greatest(aa.allocation_limit_yocto,coalesce(r.spent,0)+coalesce(r.reserved,0)),
      updated_at=pg_catalog.now()
  from (
    select a.id as agent_id,
      coalesce(sum(sr.amount_yocto) filter(where sr.status='executed'),0) as spent,
      coalesce(sum(sr.amount_yocto) filter(where sr.status in ('awaiting_approval','reserved','needs_review')),0) as reserved
    from public.agents a
    left join public.spend_reservations sr on sr.agent_id=a.id
    group by a.id
  ) r
  where aa.agent_id=r.agent_id;

  select coalesce(sum(allocation_limit_yocto),0) into v_allocated from public.agent_allocations;
  if v_allocated>v_budget.total_limit_yocto then
    raise exception 'allocation_reconcile_allocations_exceed_treasury';
  end if;
end;
$allocation_reconcile$;

create or replace function public.set_agent_allocation(
 p_agent_id text,p_allocation_limit_yocto numeric,p_actor_agent_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
 v_budget public.agent_budgets%rowtype;
 v_allocation public.agent_allocations%rowtype;
 v_other_allocations numeric;
begin
 if p_agent_id is null or p_actor_agent_id is null or p_allocation_limit_yocto is null
   or p_allocation_limit_yocto<0 or p_allocation_limit_yocto>=1e78
   or p_allocation_limit_yocto<>pg_catalog.trunc(p_allocation_limit_yocto) then
  raise exception 'invalid_agent_allocation';
 end if;
 select * into v_budget from public.agent_budgets where id='default' for update;
 if not found then raise exception 'budget_not_configured'; end if;
 select * into v_allocation from public.agent_allocations where agent_id=p_agent_id for update;
 if not found then raise exception 'agent_allocation_not_configured'; end if;
 if p_allocation_limit_yocto<v_allocation.spent_yocto+v_allocation.reserved_yocto then
  raise exception 'allocation_below_committed_amounts';
 end if;
 select coalesce(sum(allocation_limit_yocto),0) into v_other_allocations
 from public.agent_allocations where agent_id<>p_agent_id;
 if v_other_allocations+p_allocation_limit_yocto>v_budget.total_limit_yocto then
  raise exception 'allocations_exceed_treasury_limit';
 end if;
 update public.agent_allocations
 set allocation_limit_yocto=p_allocation_limit_yocto,updated_at=pg_catalog.now(),updated_by=p_actor_agent_id
 where agent_id=p_agent_id;
 insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
 values(p_actor_agent_id,'agent_allocation_updated',p_agent_id,
  pg_catalog.jsonb_build_object('previous_allocation_limit_yocto',v_allocation.allocation_limit_yocto::text,
   'new_allocation_limit_yocto',p_allocation_limit_yocto::text,
   'spent_yocto',v_allocation.spent_yocto::text,'reserved_yocto',v_allocation.reserved_yocto::text));
 return pg_catalog.jsonb_build_object('agent_id',p_agent_id,'allocation_limit_yocto',p_allocation_limit_yocto::text,
  'spent_yocto',v_allocation.spent_yocto::text,'reserved_yocto',v_allocation.reserved_yocto::text,
  'available_yocto',(p_allocation_limit_yocto-v_allocation.spent_yocto-v_allocation.reserved_yocto)::text);
end;
$$;

create or replace function public.reserve_agent_spend(
  p_request_id text,p_amount_yocto numeric,p_recipient text,p_agent_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_budget public.agent_budgets%rowtype;
  v_allocation public.agent_allocations%rowtype;
  v_existing public.spend_reservations%rowtype;
  v_policy public.agent_policies%rowtype;
  v_active boolean; v_enabled boolean;
  v_daily numeric; v_weekly numeric;
begin
  if p_request_id is null or pg_catalog.length(p_request_id)<8 then raise exception 'invalid_request_id'; end if;
  if p_amount_yocto is null or p_amount_yocto<=0 or p_amount_yocto>=1e78
    or p_amount_yocto<>pg_catalog.trunc(p_amount_yocto) then raise exception 'invalid_amount'; end if;
  if p_recipient is null or pg_catalog.length(p_recipient)<2 or pg_catalog.length(p_recipient)>64
    or p_recipient !~ ('^[a-z0-9]+([._-][a-z0-9]+)*' || chr(36)) then
    raise exception 'invalid_recipient';
  end if;
  select * into v_budget from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select * into v_allocation from public.agent_allocations where agent_id=p_agent_id for update;
  if not found then raise exception 'agent_allocation_not_configured'; end if;
  select active into v_active from public.agents where id=p_agent_id for share;
  if not coalesce(v_active,false) then raise exception 'agent_not_active'; end if;
  select * into v_existing from public.spend_reservations where request_id=p_request_id for update;
  if found then
    if v_existing.amount_yocto<>p_amount_yocto or v_existing.recipient<>p_recipient or v_existing.agent_id<>p_agent_id then
      raise exception 'idempotency_key_conflict';
    end if;
    return pg_catalog.jsonb_build_object('created',false,'status',v_existing.status,'request_id',p_request_id,'agent_id',p_agent_id);
  end if;
  select transfers_enabled into v_enabled from public.agentguard_system_controls where id='default' for share;
  if not coalesce(v_enabled,false) then
    insert into public.agentguard_security_events(actor_agent_id,event_type,request_id,details)
    values(p_agent_id,'transfer_emergency_stop_blocked',p_request_id,
      pg_catalog.jsonb_build_object('amount_yocto',p_amount_yocto::text,'recipient',p_recipient));
    return pg_catalog.jsonb_build_object('created',false,'status','blocked','reason','emergency_stop');
  end if;
  select * into v_policy from public.agent_policies where agent_id=p_agent_id for share;
  if not found then raise exception 'agent_policy_not_configured'; end if;
  if v_policy.max_transfer_yocto is not null and p_amount_yocto>v_policy.max_transfer_yocto then
    return pg_catalog.jsonb_build_object('created',false,'status','blocked','reason','agent_per_transfer_limit');
  end if;
  if v_policy.allowed_recipients is not null and not (p_recipient=any(v_policy.allowed_recipients)) then
    return pg_catalog.jsonb_build_object('created',false,'status','blocked','reason','recipient_not_allowed');
  end if;
  if v_policy.daily_limit_yocto is not null then
    select coalesce(sum(amount_yocto),0) into v_daily from public.spend_reservations
    where agent_id=p_agent_id and created_at>=pg_catalog.now()-interval '24 hours'
      and status in ('awaiting_approval','reserved','needs_review','executed');
    if v_daily+p_amount_yocto>v_policy.daily_limit_yocto then
      return pg_catalog.jsonb_build_object('created',false,'status','blocked','reason','agent_daily_limit');
    end if;
  end if;
  if v_policy.weekly_limit_yocto is not null then
    select coalesce(sum(amount_yocto),0) into v_weekly from public.spend_reservations
    where agent_id=p_agent_id and created_at>=pg_catalog.now()-interval '7 days'
      and status in ('awaiting_approval','reserved','needs_review','executed');
    if v_weekly+p_amount_yocto>v_policy.weekly_limit_yocto then
      return pg_catalog.jsonb_build_object('created',false,'status','blocked','reason','agent_weekly_limit');
    end if;
  end if;
  if v_allocation.spent_yocto+v_allocation.reserved_yocto+p_amount_yocto>v_allocation.allocation_limit_yocto then
    return pg_catalog.jsonb_build_object('created',false,'status','blocked','reason','agent_allocation_exceeded');
  end if;
  if v_budget.spent_yocto+v_budget.reserved_yocto+p_amount_yocto>v_budget.total_limit_yocto then
    return pg_catalog.jsonb_build_object('created',false,'status','blocked','reason','total_budget_exceeded');
  end if;
  insert into public.spend_reservations(request_id,amount_yocto,recipient,status,agent_id,approval_expires_at)
  values(p_request_id,p_amount_yocto,p_recipient,'awaiting_approval',p_agent_id,pg_catalog.now()+interval '15 minutes');
  update public.agent_budgets set reserved_yocto=reserved_yocto+p_amount_yocto,updated_at=pg_catalog.now() where id='default';
  update public.agent_allocations set reserved_yocto=reserved_yocto+p_amount_yocto,updated_at=pg_catalog.now() where agent_id=p_agent_id;
  insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
  values(p_agent_id,'transfer_submitted_for_approval',p_request_id,
    pg_catalog.jsonb_build_object('recipient',p_recipient,'amount_yocto',p_amount_yocto::text));
  return pg_catalog.jsonb_build_object('created',true,'status','awaiting_approval','request_id',p_request_id,
    'agent_id',p_agent_id,'approval_expires_at',pg_catalog.now()+interval '15 minutes');
end;
$$;

create or replace function public.approve_agent_transfer(p_request_id text,p_actor_agent_id text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_reservation public.spend_reservations%rowtype;
  v_allocation public.agent_allocations%rowtype;
  v_target_agent_id text;
  v_policy public.agent_policies%rowtype;
  v_enabled boolean; v_active boolean; v_daily numeric; v_weekly numeric;
begin
  if p_actor_agent_id is null or p_actor_agent_id = 'system:outlayer' then
    raise exception 'invalid_approval_actor';
  end if;
  perform 1 from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select agent_id into v_target_agent_id from public.spend_reservations where request_id=p_request_id;
  if not found then raise exception 'reservation_not_found'; end if;
  select * into v_allocation from public.agent_allocations where agent_id=v_target_agent_id for update;
  if not found then raise exception 'agent_allocation_not_configured'; end if;
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
  if v_allocation.spent_yocto+v_allocation.reserved_yocto>v_allocation.allocation_limit_yocto then
    raise exception 'agent_allocation_exceeded';
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

create or replace function public.reject_agent_transfer(p_request_id text,p_actor_agent_id text,p_reason text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_reservation public.spend_reservations%rowtype; v_target_agent_id text;
begin
  if p_actor_agent_id is null or p_reason is null or pg_catalog.length(pg_catalog.btrim(p_reason))<3 then
    raise exception 'invalid_rejection';
  end if;
  perform 1 from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select agent_id into v_target_agent_id from public.spend_reservations where request_id=p_request_id;
  if not found then raise exception 'reservation_not_found'; end if;
  perform 1 from public.agent_allocations where agent_id=v_target_agent_id for update;
  if not found then raise exception 'agent_allocation_not_configured'; end if;
  select * into v_reservation from public.spend_reservations where request_id=p_request_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if v_reservation.status<>'awaiting_approval' or v_reservation.submission_claimed_at is not null then raise exception 'approval_not_pending'; end if;
  update public.agent_budgets set reserved_yocto=reserved_yocto-v_reservation.amount_yocto,updated_at=pg_catalog.now() where id='default';
  update public.agent_allocations set reserved_yocto=reserved_yocto-v_reservation.amount_yocto,updated_at=pg_catalog.now() where agent_id=v_reservation.agent_id;
  update public.spend_reservations set status='rejected',rejected_at=pg_catalog.now(),rejected_by=p_actor_agent_id,
    approval_reason=pg_catalog.left(p_reason,500),updated_at=pg_catalog.now() where request_id=p_request_id;
  insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
  values(p_actor_agent_id,'transfer_rejected',p_request_id,pg_catalog.jsonb_build_object('agent_id',v_reservation.agent_id,'reason',pg_catalog.left(p_reason,500)));
  return pg_catalog.jsonb_build_object('request_id',p_request_id,'status','rejected');
end;
$$;

create or replace function public.cancel_expired_agent_transfer(
  p_request_id text,
  p_actor_agent_id text,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_reservation public.spend_reservations%rowtype; v_evidence text; v_target_agent_id text;
begin
  if p_actor_agent_id is null or p_reason is null or pg_catalog.length(pg_catalog.btrim(p_reason))<3 then
    raise exception 'invalid_resolution_details';
  end if;
  perform 1 from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select agent_id into v_target_agent_id from public.spend_reservations where request_id=p_request_id;
  if not found then raise exception 'reservation_not_found'; end if;
  perform 1 from public.agent_allocations where agent_id=v_target_agent_id for update;
  if not found then raise exception 'agent_allocation_not_configured'; end if;
  select * into v_reservation from public.spend_reservations where request_id=p_request_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if v_reservation.status<>'awaiting_approval'
     or v_reservation.approval_expires_at is null
     or v_reservation.approval_expires_at>pg_catalog.now()
     or v_reservation.approved_at is not null
     or v_reservation.submission_claimed_at is not null
     or v_reservation.outlayer_tx_hash is not null
     or v_reservation.outlayer_request_id is not null then
    raise exception 'reservation_not_safely_cancellable';
  end if;
  v_evidence := 'database:approval_expired_at=' || v_reservation.approval_expires_at::text;
  update public.agent_budgets
  set reserved_yocto=reserved_yocto-v_reservation.amount_yocto,updated_at=pg_catalog.now()
  where id='default';
  update public.agent_allocations
  set reserved_yocto=reserved_yocto-v_reservation.amount_yocto,updated_at=pg_catalog.now()
  where agent_id=v_reservation.agent_id;
  update public.spend_reservations
  set status='cancelled',cancelled_at=pg_catalog.now(),cancelled_by=p_actor_agent_id,
      resolved_at=pg_catalog.now(),resolved_by=p_actor_agent_id,
      resolution_reason=pg_catalog.left(pg_catalog.btrim(p_reason),500),
      resolution_evidence_reference=v_evidence,
      updated_at=pg_catalog.now()
  where request_id=p_request_id;
  insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
  values(p_actor_agent_id,'expired_transfer_cancelled',p_request_id,
    pg_catalog.jsonb_build_object('agent_id',v_reservation.agent_id,'reason',pg_catalog.left(pg_catalog.btrim(p_reason),500),
      'evidence_reference',v_evidence,'amount_yocto',v_reservation.amount_yocto::text));
  return pg_catalog.jsonb_build_object('request_id',p_request_id,'status','cancelled','evidence_reference',v_evidence);
end;
$$;

create or replace function public.finish_agent_spend(
  p_request_id text,
  p_outcome text,
  p_tx_hash text default null,
  p_error text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.spend_reservations%rowtype;
  v_target_agent_id text;
begin
  if p_outcome is null or p_outcome not in ('executed','failed','needs_review') then
    raise exception 'invalid_outcome';
  end if;

  perform 1 from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select agent_id into v_target_agent_id from public.spend_reservations where request_id=p_request_id;
  if not found then raise exception 'reservation_not_found'; end if;
  perform 1 from public.agent_allocations where agent_id=v_target_agent_id for update;
  if not found then raise exception 'agent_allocation_not_configured'; end if;

  select * into v_reservation
  from public.spend_reservations where request_id=p_request_id for update;
  if not found then raise exception 'reservation_not_found'; end if;

  if v_reservation.status not in ('reserved','needs_review') then
    return pg_catalog.jsonb_build_object('status',v_reservation.status,'request_id',p_request_id);
  end if;

  if p_outcome='executed' then
    update public.agent_budgets
    set reserved_yocto=reserved_yocto-v_reservation.amount_yocto,
        spent_yocto=spent_yocto+v_reservation.amount_yocto,
        updated_at=pg_catalog.now()
    where id='default';
    update public.agent_allocations
    set reserved_yocto=reserved_yocto-v_reservation.amount_yocto,
        spent_yocto=spent_yocto+v_reservation.amount_yocto,
        updated_at=pg_catalog.now()
    where agent_id=v_reservation.agent_id;
  elsif p_outcome='failed' then
    update public.agent_budgets
    set reserved_yocto=reserved_yocto-v_reservation.amount_yocto,
        updated_at=pg_catalog.now()
    where id='default';
    update public.agent_allocations
    set reserved_yocto=reserved_yocto-v_reservation.amount_yocto,
        updated_at=pg_catalog.now()
    where agent_id=v_reservation.agent_id;
  end if;

  update public.spend_reservations
  set status=p_outcome,
      outlayer_tx_hash=coalesce(p_tx_hash,outlayer_tx_hash),
      last_error=p_error,
      updated_at=pg_catalog.now()
  where request_id=p_request_id;

  insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
  values('system:near-finality',
    case when p_outcome='needs_review' then 'transfer_marked_needs_review' else 'transfer_finalized' end,
    p_request_id,pg_catalog.jsonb_build_object(
      'agent_id',v_reservation.agent_id,
      'outcome',p_outcome,
      'tx_hash',coalesce(p_tx_hash,v_reservation.outlayer_tx_hash),
      'error',p_error
    ));

  return pg_catalog.jsonb_build_object('status',p_outcome,'request_id',p_request_id);
end;
$$;

create or replace function public.resolve_agent_transfer_failed_final(
  p_request_id text,
  p_actor_agent_id text,
  p_reason text,
  p_evidence_reference text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_reservation public.spend_reservations%rowtype; v_target_agent_id text;
begin
  if p_actor_agent_id is null or p_reason is null or pg_catalog.length(pg_catalog.btrim(p_reason))<3
     or p_evidence_reference is null or pg_catalog.length(pg_catalog.btrim(p_evidence_reference))<8 then
    raise exception 'invalid_resolution_details';
  end if;
  perform 1 from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select agent_id into v_target_agent_id from public.spend_reservations where request_id=p_request_id;
  if not found then raise exception 'reservation_not_found'; end if;
  perform 1 from public.agent_allocations where agent_id=v_target_agent_id for update;
  if not found then raise exception 'agent_allocation_not_configured'; end if;
  select * into v_reservation from public.spend_reservations where request_id=p_request_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if v_reservation.status not in ('reserved','needs_review') or v_reservation.outlayer_tx_hash is null then
    raise exception 'reservation_not_resolvable';
  end if;
  update public.agent_budgets
  set reserved_yocto=reserved_yocto-v_reservation.amount_yocto,updated_at=pg_catalog.now()
  where id='default';
  update public.agent_allocations
  set reserved_yocto=reserved_yocto-v_reservation.amount_yocto,updated_at=pg_catalog.now()
  where agent_id=v_reservation.agent_id;
  update public.spend_reservations
  set status='failed',resolved_at=pg_catalog.now(),resolved_by=p_actor_agent_id,
      resolution_reason=pg_catalog.left(pg_catalog.btrim(p_reason),500),
      resolution_evidence_reference=pg_catalog.left(pg_catalog.btrim(p_evidence_reference),500),
      last_error=pg_catalog.left(pg_catalog.btrim(p_reason),500),
      updated_at=pg_catalog.now()
  where request_id=p_request_id;
  insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
  values(p_actor_agent_id,'transfer_resolved_failed_final',p_request_id,
    pg_catalog.jsonb_build_object('agent_id',v_reservation.agent_id,'reason',pg_catalog.left(pg_catalog.btrim(p_reason),500),
      'evidence_reference',pg_catalog.left(pg_catalog.btrim(p_evidence_reference),500),
      'tx_hash',v_reservation.outlayer_tx_hash,'finality','FINAL',
      'amount_yocto',v_reservation.amount_yocto::text));
  return pg_catalog.jsonb_build_object('request_id',p_request_id,'status','failed');
end;
$$;

create or replace function public.record_outlayer_submission(
 p_request_id text, p_tx_hash text default null,
 p_provider_request_id text default null, p_error text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $agentguard$
declare reservation public.spend_reservations%rowtype; target_agent_id text;
begin
 perform 1 from public.agent_budgets where id = 'default' for update;
 if not found then raise exception 'budget_not_configured'; end if;
 select agent_id into target_agent_id from public.spend_reservations where request_id=p_request_id;
 if not found then raise exception 'reservation_not_found'; end if;
 perform 1 from public.agent_allocations where agent_id=target_agent_id for update;
 if not found then raise exception 'agent_allocation_not_configured'; end if;
 select * into reservation from public.spend_reservations
 where request_id = p_request_id for update;
 if not found then raise exception 'reservation_not_found'; end if;
 if reservation.status not in ('reserved', 'needs_review') then
  return pg_catalog.jsonb_build_object('status', reservation.status, 'request_id', p_request_id);
 end if;
 if reservation.outlayer_tx_hash is not null and p_tx_hash is not null
    and reservation.outlayer_tx_hash <> p_tx_hash then
  raise exception 'provider_transaction_hash_conflict';
 end if;
 if reservation.outlayer_request_id is not null and p_provider_request_id is not null
    and reservation.outlayer_request_id <> p_provider_request_id then
  raise exception 'provider_request_id_conflict';
 end if;
 update public.spend_reservations as sr
 set status = 'needs_review',
     outlayer_tx_hash = coalesce(sr.outlayer_tx_hash, p_tx_hash),
     outlayer_request_id = coalesce(sr.outlayer_request_id, p_provider_request_id),
     last_error = p_error, updated_at = pg_catalog.now()
 where sr.request_id = p_request_id;
 -- Record the first transition only. Replayed provider callbacks must not
 -- manufacture duplicate audit events for the same reservation.
 if reservation.status = 'reserved' then
  insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
  values('system:outlayer','provider_submission_recorded',p_request_id,
    pg_catalog.jsonb_build_object('agent_id',reservation.agent_id,'tx_hash',p_tx_hash,
      'provider_request_id',p_provider_request_id,'error',p_error));
 end if;
 return pg_catalog.jsonb_build_object('status', 'needs_review', 'request_id', p_request_id);
end;
$agentguard$;

create or replace function public.update_agent_budget_limit(p_new_limit_yocto numeric, p_actor_agent_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_budget public.agent_budgets%rowtype;
  v_allocated numeric;
begin
  if p_new_limit_yocto is null or p_new_limit_yocto <= 0 or p_new_limit_yocto <> trunc(p_new_limit_yocto) then
    raise exception 'invalid_budget_limit';
  end if;

  select * into v_budget
  from public.agent_budgets
  where id = 'default'
  for update;

  if not found then raise exception 'budget_not_configured'; end if;
  if p_actor_agent_id is null then raise exception 'invalid_budget_actor'; end if;
  if p_new_limit_yocto < v_budget.spent_yocto + v_budget.reserved_yocto then
    raise exception 'budget_below_committed_amounts';
  end if;

  select coalesce(sum(allocation_limit_yocto),0) into v_allocated from public.agent_allocations;
  if p_new_limit_yocto < v_allocated then raise exception 'budget_below_allocated_amounts'; end if;

  update public.agent_budgets
  set total_limit_yocto = p_new_limit_yocto,
      updated_at = pg_catalog.now()
  where id = 'default';

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (p_actor_agent_id, 'budget_limit_updated', 'default',
    pg_catalog.jsonb_build_object('previous_limit_yocto', v_budget.total_limit_yocto::text,
                                  'new_limit_yocto', p_new_limit_yocto::text,
                                  'allocated_yocto',v_allocated::text));

  return pg_catalog.jsonb_build_object(
    'total_limit_yocto', p_new_limit_yocto::text,
    'spent_yocto', v_budget.spent_yocto::text,
    'reserved_yocto', v_budget.reserved_yocto::text,
    'allocated_yocto',v_allocated::text
  );
end;
$$;

create or replace function public.create_agent_with_audit(
  p_agent_id text,
  p_name text,
  p_token_hash text,
  p_actor_agent_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_agent public.agents%rowtype;
begin
  if p_agent_id is null or p_agent_id = 'primary'
     or p_agent_id !~ '^[a-z0-9_-]{2,48}$'
     or p_name is null or pg_catalog.length(pg_catalog.btrim(p_name)) < 2
     or pg_catalog.length(p_name) > 80
     or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_actor_agent_id is null then
    raise exception 'invalid_agent_creation';
  end if;

  perform 1 from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  insert into public.agents(id,name,token_hash,active)
  values(p_agent_id,pg_catalog.btrim(p_name),p_token_hash,true)
  returning * into v_agent;

  insert into public.agent_policies(agent_id) values(p_agent_id);
  insert into public.agent_allocations(agent_id,allocation_limit_yocto,spent_yocto,reserved_yocto,updated_by)
  values(p_agent_id,0,0,0,p_actor_agent_id);

  insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
  values(p_actor_agent_id,'agent_credential_created',p_agent_id,
    pg_catalog.jsonb_build_object('name',v_agent.name,'allocation_limit_yocto','0'));

  return pg_catalog.jsonb_build_object('id',v_agent.id,'name',v_agent.name,'allocation_limit_yocto','0');
end;
$$;

revoke all on function public.set_agent_allocation(text,numeric,text) from public,anon,authenticated;
grant execute on function public.set_agent_allocation(text,numeric,text) to service_role;
revoke all on function public.reserve_agent_spend(text,numeric,text,text) from public,anon,authenticated;
revoke all on function public.approve_agent_transfer(text,text) from public,anon,authenticated;
revoke all on function public.reject_agent_transfer(text,text,text) from public,anon,authenticated;
revoke all on function public.cancel_expired_agent_transfer(text,text,text) from public,anon,authenticated;
revoke all on function public.finish_agent_spend(text,text,text,text) from public,anon,authenticated;
revoke all on function public.resolve_agent_transfer_failed_final(text,text,text,text) from public,anon,authenticated;
revoke all on function public.record_outlayer_submission(text,text,text,text) from public,anon,authenticated;
revoke all on function public.update_agent_budget_limit(numeric,text) from public,anon,authenticated;
revoke all on function public.create_agent_with_audit(text,text,text,text) from public,anon,authenticated;

grant execute on function public.reserve_agent_spend(text,numeric,text,text) to service_role;
grant execute on function public.approve_agent_transfer(text,text) to service_role;
grant execute on function public.reject_agent_transfer(text,text,text) to service_role;
grant execute on function public.cancel_expired_agent_transfer(text,text,text) to service_role;
grant execute on function public.finish_agent_spend(text,text,text,text) to service_role;
grant execute on function public.resolve_agent_transfer_failed_final(text,text,text,text) to service_role;
grant execute on function public.record_outlayer_submission(text,text,text,text) to service_role;
grant execute on function public.update_agent_budget_limit(numeric,text) to service_role;
grant execute on function public.create_agent_with_audit(text,text,text,text) to service_role;

commit;
