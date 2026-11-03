-- CI trigger: exercise recipient registry in the legacy upgrade and concurrent reservation suites.
-- Per-agent exact NEAR recipient authorization registry.
-- Requires treasury/agent allocation ledger migrations.
begin;

create table public.agent_authorized_recipients (
  agent_id text not null references public.agents(id) on delete restrict,
  account_id text not null,
  label text,
  status text not null default 'active' check(status in ('active','revoked')),
  authorized_at timestamptz not null default now(),
  authorized_by text not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(agent_id,account_id),
  constraint agent_authorized_recipients_account_format check(
    pg_catalog.length(account_id) between 2 and 64
    and account_id ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
  ),
  constraint agent_authorized_recipients_status_fields check(
    (status='active' and revoked_at is null and revoked_by is null)
    or (status='revoked' and revoked_at is not null and revoked_by is not null)
  ),
  constraint agent_authorized_recipients_expiry_future check(expires_at is null or expires_at>authorized_at)
);

-- Only explicitly configured legacy allowlists are migrated. NULL (previously
-- unrestricted) intentionally becomes no authorization.
insert into public.agent_authorized_recipients(agent_id,account_id,label,status,authorized_at,authorized_by)
select p.agent_id,recipient,recipient,'active',pg_catalog.now(),'system:legacy-policy-backfill'
from public.agent_policies p
cross join lateral pg_catalog.unnest(p.allowed_recipients) as recipient
where p.allowed_recipients is not null
on conflict(agent_id,account_id) do nothing;

alter table public.agent_authorized_recipients enable row level security;
revoke all on public.agent_authorized_recipients from public,anon,authenticated,service_role;
grant select on public.agent_authorized_recipients to service_role;



create or replace function public.authorize_agent_recipient(
 p_agent_id text,p_account_id text,p_label text,p_expires_at timestamptz,p_actor_agent_id text
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
 v_allocation public.agent_allocations%rowtype;
 v_existing public.agent_authorized_recipients%rowtype;
 v_created boolean;
begin
 if p_agent_id is null or p_account_id is null or p_actor_agent_id is null
   or pg_catalog.length(p_account_id)<2 or pg_catalog.length(p_account_id)>64
   or p_account_id !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
   or (p_label is not null and pg_catalog.length(pg_catalog.btrim(p_label))>80)
   or (p_expires_at is not null and p_expires_at<=pg_catalog.now()) then
  raise exception 'invalid_recipient_authorization';
 end if;
 perform 1 from public.agent_budgets where id='default' for update;
 if not found then raise exception 'budget_not_configured'; end if;
 select * into v_allocation from public.agent_allocations where agent_id=p_agent_id for update;
 if not found then raise exception 'agent_allocation_not_configured'; end if;
 select * into v_existing from public.agent_authorized_recipients
 where agent_id=p_agent_id and account_id=p_account_id for update;
 v_created := not found;
 if v_created then
  insert into public.agent_authorized_recipients(agent_id,account_id,label,status,authorized_at,authorized_by,expires_at)
  values(p_agent_id,p_account_id,nullif(pg_catalog.btrim(p_label),''),'active',pg_catalog.now(),p_actor_agent_id,p_expires_at);
 else
  update public.agent_authorized_recipients
  set label=nullif(pg_catalog.btrim(p_label),''),
      status='active',authorized_at=pg_catalog.now(),authorized_by=p_actor_agent_id,
      expires_at=p_expires_at,revoked_at=null,revoked_by=null,updated_at=pg_catalog.now()
  where agent_id=p_agent_id and account_id=p_account_id;
 end if;
 insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
 values(p_actor_agent_id,'recipient_authorized',p_agent_id,
  pg_catalog.jsonb_build_object('account_id',p_account_id,'label',nullif(pg_catalog.btrim(p_label),''),
   'expires_at',p_expires_at,'reactivated',not v_created));
 return pg_catalog.jsonb_build_object('agent_id',p_agent_id,'account_id',p_account_id,
  'label',nullif(pg_catalog.btrim(p_label),''),'status','active','expires_at',p_expires_at,
  'created',v_created);
end;
$$;

create or replace function public.revoke_agent_recipient(
 p_agent_id text,p_account_id text,p_reason text,p_actor_agent_id text
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
 v_allocation public.agent_allocations%rowtype;
 v_recipient public.agent_authorized_recipients%rowtype;
 v_pending bigint;
 v_claimed bigint;
 v_submitted bigint;
begin
 if p_agent_id is null or p_account_id is null or p_actor_agent_id is null
   or p_reason is null or pg_catalog.length(pg_catalog.btrim(p_reason))<3 then
  raise exception 'invalid_recipient_revocation';
 end if;
 perform 1 from public.agent_budgets where id='default' for update;
 if not found then raise exception 'budget_not_configured'; end if;
 select * into v_allocation from public.agent_allocations where agent_id=p_agent_id for update;
 if not found then raise exception 'agent_allocation_not_configured'; end if;
 select * into v_recipient from public.agent_authorized_recipients
 where agent_id=p_agent_id and account_id=p_account_id for update;
 if not found then raise exception 'recipient_authorization_not_found'; end if;
 if v_recipient.status='revoked' then
  return pg_catalog.jsonb_build_object('agent_id',p_agent_id,'account_id',p_account_id,
   'status','revoked','already_revoked',true,'pending_approvals',0,'claimed_inflight',0,'provider_submitted',0);
 end if;

 select count(*) into v_pending from public.spend_reservations
 where agent_id=p_agent_id and recipient=p_account_id
   and status='awaiting_approval' and submission_claimed_at is null;
 select count(*) into v_claimed from public.spend_reservations
 where agent_id=p_agent_id and recipient=p_account_id
   and status in ('reserved','needs_review') and submission_claimed_at is not null
   and outlayer_tx_hash is null and outlayer_request_id is null;
 select count(*) into v_submitted from public.spend_reservations
 where agent_id=p_agent_id and recipient=p_account_id
   and status in ('reserved','needs_review')
   and (outlayer_tx_hash is not null or outlayer_request_id is not null);

 update public.agent_authorized_recipients
 set status='revoked',revoked_at=pg_catalog.now(),revoked_by=p_actor_agent_id,updated_at=pg_catalog.now()
 where agent_id=p_agent_id and account_id=p_account_id;

 insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
 values(p_actor_agent_id,'recipient_revoked',p_agent_id,
  pg_catalog.jsonb_build_object('account_id',p_account_id,'reason',pg_catalog.left(pg_catalog.btrim(p_reason),500),
   'pending_approvals',v_pending,'claimed_inflight',v_claimed,'provider_submitted',v_submitted));
 return pg_catalog.jsonb_build_object('agent_id',p_agent_id,'account_id',p_account_id,
  'status','revoked','pending_approvals',v_pending,'claimed_inflight',v_claimed,'provider_submitted',v_submitted);
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
  v_recipient_auth public.agent_authorized_recipients%rowtype;
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
  select * into v_recipient_auth
  from public.agent_authorized_recipients
  where agent_id=p_agent_id and account_id=p_recipient
    and status='active' and (expires_at is null or expires_at>pg_catalog.now())
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('created',false,'status','blocked','reason','recipient_not_authorized');
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
  v_recipient_auth public.agent_authorized_recipients%rowtype;
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
  select * into v_recipient_auth
  from public.agent_authorized_recipients
  where agent_id=v_reservation.agent_id and account_id=v_reservation.recipient
    and status='active' and (expires_at is null or expires_at>pg_catalog.now())
  for update;
  if not found then raise exception 'recipient_not_authorized'; end if;
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

revoke all on function public.authorize_agent_recipient(text,text,text,timestamptz,text) from public,anon,authenticated;
revoke all on function public.revoke_agent_recipient(text,text,text,text) from public,anon,authenticated;
grant execute on function public.authorize_agent_recipient(text,text,text,timestamptz,text) to service_role;
grant execute on function public.revoke_agent_recipient(text,text,text,text) to service_role;

revoke all on function public.reserve_agent_spend(text,numeric,text,text) from public,anon,authenticated;
revoke all on function public.approve_agent_transfer(text,text) from public,anon,authenticated;
grant execute on function public.reserve_agent_spend(text,numeric,text,text) to service_role;
grant execute on function public.approve_agent_transfer(text,text) to service_role;

commit;

-- Upgrade suite assertion refinement: distinguish missing from duplicate finality audit events.
