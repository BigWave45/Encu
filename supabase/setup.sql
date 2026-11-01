-- AgentGuard fresh database setup
-- Run this on a NEW Supabase project only.
-- Existing installations must use the documented upgrade migrations instead.
--
-- This schema includes multi-agent V1 from the start:
-- one shared budget, independently authenticated agents, and reservations
-- attributed to the authenticated agent identity.

create table if not exists public.agent_budgets (
  id text primary key,
  total_limit_yocto numeric(78, 0) not null check (total_limit_yocto >= 0),
  spent_yocto numeric(78, 0) not null default 0 check (spent_yocto >= 0),
  reserved_yocto numeric(78, 0) not null default 0 check (reserved_yocto >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.agents (
  id text primary key,
  name text not null,
  token_hash text unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.agents (id, name, active)
values ('primary', 'Primary Agent', true)
on conflict (id) do nothing;

create table if not exists public.spend_reservations (
  request_id text primary key,
  amount_yocto numeric(78, 0) not null check (amount_yocto > 0),
  recipient text not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'executed', 'failed', 'needs_review')),
  outlayer_tx_hash text,
  outlayer_request_id text,
  last_error text,
  agent_id text not null default 'primary'
    references public.agents(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists spend_reservations_agent_id_created_at_idx
  on public.spend_reservations (agent_id, created_at desc);

insert into public.agent_budgets (id, total_limit_yocto)
values ('default', 5000000000000000000000000)
on conflict (id) do nothing;



create or replace function public.reserve_agent_spend(
  p_request_id text,
  p_amount_yocto numeric,
  p_recipient text,
  p_agent_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  budget public.agent_budgets%rowtype;
  existing public.spend_reservations%rowtype;
  agent_active boolean;
begin
  if p_request_id is null or length(p_request_id) < 8 then
    raise exception 'invalid_request_id';
  end if;

  -- numeric(78,0) cannot store 10^78 or larger.
  if p_amount_yocto is null or p_amount_yocto <= 0 or p_amount_yocto >= 1e78 then
    raise exception 'invalid_amount';
  end if;

  -- Prevent an agent from being deactivated between authentication and reservation.
  select active into agent_active
  from public.agents
  where id = p_agent_id
  for share;

  if not coalesce(agent_active, false) then
    raise exception 'agent_not_active';
  end if;

  -- Serialises reservations across every agent sharing this budget.
  select * into budget
  from public.agent_budgets
  where id = 'default'
  for update;

  if not found then
    raise exception 'budget_not_configured';
  end if;

  select * into existing
  from public.spend_reservations
  where request_id = p_request_id
  for update;

  if found then
    if existing.amount_yocto <> p_amount_yocto
       or existing.recipient <> p_recipient
       or existing.agent_id <> p_agent_id then
      raise exception 'idempotency_key_conflict';
    end if;

    return jsonb_build_object(
      'created', false,
      'status', existing.status,
      'request_id', existing.request_id,
      'agent_id', existing.agent_id
    );
  end if;

  if budget.spent_yocto + budget.reserved_yocto + p_amount_yocto
     > budget.total_limit_yocto then
    return jsonb_build_object(
      'created', false,
      'status', 'blocked',
      'reason', 'total_budget_exceeded'
    );
  end if;

  insert into public.spend_reservations
    (request_id, amount_yocto, recipient, status, agent_id)
  values
    (p_request_id, p_amount_yocto, p_recipient, 'reserved', p_agent_id);

  update public.agent_budgets
  set reserved_yocto = reserved_yocto + p_amount_yocto,
      updated_at = now()
  where id = 'default';

  return jsonb_build_object(
    'created', true,
    'status', 'reserved',
    'request_id', p_request_id,
    'agent_id', p_agent_id
  );
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
set search_path = public
as $$
declare
  reservation public.spend_reservations%rowtype;
begin
  if p_outcome is null or p_outcome not in ('executed', 'failed', 'needs_review') then
    raise exception 'invalid_outcome';
  end if;

  -- Keep the same lock order as reservation creation.
  perform 1
  from public.agent_budgets
  where id = 'default'
  for update;

  if not found then
    raise exception 'budget_not_configured';
  end if;

  select * into reservation
  from public.spend_reservations
  where request_id = p_request_id
  for update;

  if not found then
    raise exception 'reservation_not_found';
  end if;

  -- Terminal reservations cannot be settled twice.
  if reservation.status not in ('reserved', 'needs_review') then
    return jsonb_build_object(
      'status', reservation.status,
      'request_id', p_request_id
    );
  end if;

  if p_outcome = 'executed' then
    update public.agent_budgets
    set reserved_yocto = reserved_yocto - reservation.amount_yocto,
        spent_yocto = spent_yocto + reservation.amount_yocto,
        updated_at = now()
    where id = 'default';
  elsif p_outcome = 'failed' then
    update public.agent_budgets
    set reserved_yocto = reserved_yocto - reservation.amount_yocto,
        updated_at = now()
    where id = 'default';
  end if;
  -- needs_review deliberately keeps the amount reserved.

  update public.spend_reservations
  set status = p_outcome,
      outlayer_tx_hash = coalesce(p_tx_hash, outlayer_tx_hash),
      last_error = p_error,
      updated_at = now()
  where request_id = p_request_id;

  return jsonb_build_object(
    'status', p_outcome,
    'request_id', p_request_id
  );
end;
$$;

revoke all on function public.reserve_agent_spend(text, numeric, text, text) from public;
revoke all on function public.finish_agent_spend(text, text, text, text) from public;
grant execute on function public.reserve_agent_spend(text, numeric, text, text) to service_role;
grant execute on function public.finish_agent_spend(text, text, text, text) to service_role;

-- Persist provider references and mark a submission for review in one transaction.
-- This function never settles or releases budget; NEAR FINAL reconciliation does that.
create or replace function public.record_outlayer_submission(
 p_request_id text, p_tx_hash text default null,
 p_provider_request_id text default null, p_error text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $agentguard$
declare
 reservation public.spend_reservations%rowtype;
begin
 perform 1 from public.agent_budgets where id = 'default' for update;
 if not found then raise exception 'budget_not_configured'; end if;

 select * into reservation
 from public.spend_reservations
 where request_id = p_request_id
 for update;
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
     last_error = p_error,
     updated_at = pg_catalog.now()
 where sr.request_id = p_request_id;

 return pg_catalog.jsonb_build_object('status', 'needs_review', 'request_id', p_request_id);
end;
$agentguard$;
revoke all on function public.record_outlayer_submission(text,text,text,text) from public,anon,authenticated;
grant execute on function public.record_outlayer_submission(text,text,text,text) to service_role;

alter table public.agent_budgets enable row level security;
alter table public.agents enable row level security;
alter table public.spend_reservations enable row level security;


-- Admin dashboard controls and audit trail.
create table if not exists public.agentguard_admin_audit (
  id uuid primary key default gen_random_uuid(),
  actor_agent_id text not null,
  action text not null,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.agentguard_admin_audit enable row level security;
revoke all on public.agentguard_admin_audit from public, anon, authenticated;
grant select, insert on public.agentguard_admin_audit to service_role;

create or replace function public.update_agent_budget_limit(p_new_limit_yocto numeric, p_actor_agent_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_budget public.agent_budgets%rowtype;
begin
  if p_new_limit_yocto is null or p_new_limit_yocto <= 0 or p_new_limit_yocto <> trunc(p_new_limit_yocto) then
    raise exception 'invalid_budget_limit';
  end if;

  select * into v_budget
  from public.agent_budgets
  where id = 'default'
  for update;

  if not found then raise exception 'budget_not_configured'; end if;
  if p_new_limit_yocto < v_budget.spent_yocto + v_budget.reserved_yocto then
    raise exception 'budget_below_committed_amounts';
  end if;

  update public.agent_budgets
  set total_limit_yocto = p_new_limit_yocto,
      updated_at = pg_catalog.now()
  where id = 'default';

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (p_actor_agent_id, 'budget_limit_updated', 'default',
    pg_catalog.jsonb_build_object('previous_limit_yocto', v_budget.total_limit_yocto::text,
                                  'new_limit_yocto', p_new_limit_yocto::text));

  return pg_catalog.jsonb_build_object(
    'total_limit_yocto', p_new_limit_yocto::text,
    'spent_yocto', v_budget.spent_yocto::text,
    'reserved_yocto', v_budget.reserved_yocto::text
  );
end;
$$;

revoke all on function public.update_agent_budget_limit(numeric, text) from public, anon, authenticated;
grant execute on function public.update_agent_budget_limit(numeric, text) to service_role;

create or replace function public.set_agent_active(p_agent_id text, p_active boolean, p_actor_agent_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent public.agents%rowtype;
begin
  if p_agent_id = 'primary' then raise exception 'primary_agent_protected'; end if;

  update public.agents
  set active = p_active
  where id = p_agent_id
  returning * into v_agent;

  if not found then raise exception 'agent_not_found'; end if;

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (p_actor_agent_id,
          case when p_active then 'agent_activated' else 'agent_deactivated' end,
          p_agent_id,
          pg_catalog.jsonb_build_object('name', v_agent.name));

  return pg_catalog.jsonb_build_object(
    'id', v_agent.id,
    'name', v_agent.name,
    'active', v_agent.active
  );
end;
$$;

revoke all on function public.set_agent_active(text, boolean, text) from public, anon, authenticated;
grant execute on function public.set_agent_active(text, boolean, text) to service_role;


-- Server-only security event log.
create table if not exists public.agentguard_security_events (
  id uuid primary key default gen_random_uuid(),
  actor_agent_id text,
  event_type text not null,
  request_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agentguard_security_events_created_at_idx
  on public.agentguard_security_events (created_at desc);
create index if not exists agentguard_security_events_actor_created_at_idx
  on public.agentguard_security_events (actor_agent_id, created_at desc);

alter table public.agentguard_security_events enable row level security;
revoke all on public.agentguard_security_events from public, anon, authenticated;
grant select, insert on public.agentguard_security_events to service_role;


-- V1 security controls (fresh installs start with transfers disabled).
-- AgentGuard V1 controls: emergency stop, per-agent limits, recipient allowlists,
-- and persistent atomic transfer rate limiting.
-- Apply as an additive upgrade. This migration does not reset existing ledger data.


-- AgentGuard V1 security controls.
-- One canonical definition per function. Apply only after the core ledger,
-- agents, budget, and agentguard_admin_audit tables exist.

create table if not exists public.agentguard_system_controls (
  id text primary key check (id = 'default'),
  transfers_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.agentguard_system_controls(id, transfers_enabled)
values ('default', false)
on conflict (id) do nothing;

create table if not exists public.agent_policies (
  agent_id text primary key references public.agents(id) on delete cascade,
  max_transfer_yocto numeric(78,0),
  daily_limit_yocto numeric(78,0),
  weekly_limit_yocto numeric(78,0),
  allowed_recipients text[],
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint agent_policies_positive_limits check (
    (max_transfer_yocto is null or max_transfer_yocto > 0) and
    (daily_limit_yocto is null or daily_limit_yocto > 0) and
    (weekly_limit_yocto is null or weekly_limit_yocto > 0)
  )
);
insert into public.agent_policies(agent_id)
select id from public.agents
on conflict (agent_id) do nothing;

create table if not exists public.agentguard_rate_windows (
  actor_key text not null,
  action_key text not null,
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key(actor_key, action_key, window_start)
);
create index if not exists agentguard_rate_windows_window_idx
  on public.agentguard_rate_windows(window_start);

alter table public.spend_reservations
  add column if not exists submission_claimed_at timestamptz,
  add column if not exists approval_expires_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by text,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejected_by text,
  add column if not exists approval_reason text;

alter table public.spend_reservations
  drop constraint if exists spend_reservations_status_check;
alter table public.spend_reservations
  add constraint spend_reservations_status_check
  check (status in ('awaiting_approval','reserved','executed','failed','needs_review','rejected'));

alter table public.agentguard_system_controls enable row level security;
alter table public.agent_policies enable row level security;
alter table public.agentguard_rate_windows enable row level security;
revoke all on public.agentguard_system_controls from public, anon, authenticated;
revoke all on public.agent_policies from public, anon, authenticated;
revoke all on public.agentguard_rate_windows from public, anon, authenticated;
grant select on public.agentguard_system_controls to service_role;
grant select, insert, update on public.agent_policies to service_role;
grant select, insert, update, delete on public.agentguard_rate_windows to service_role;

create or replace function public.set_agentguard_transfers_enabled(
  p_enabled boolean, p_actor_agent_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_previous boolean;
begin
  if p_enabled is null or p_actor_agent_id is null then
    raise exception 'invalid_control_update';
  end if;
  perform 1 from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select transfers_enabled into v_previous
  from public.agentguard_system_controls where id = 'default' for update;
  if not found then raise exception 'system_controls_not_configured'; end if;
  update public.agentguard_system_controls
  set transfers_enabled = p_enabled, updated_at = pg_catalog.now(),
      updated_by = p_actor_agent_id where id = 'default';
  insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
  values (p_actor_agent_id,'transfers_enabled_changed','default',
    pg_catalog.jsonb_build_object('previous',v_previous,'enabled',p_enabled));
  return pg_catalog.jsonb_build_object('transfers_enabled',p_enabled);
end;
$$;

create or replace function public.set_agent_policy(
  p_agent_id text,
  p_max_transfer_yocto numeric default null,
  p_daily_limit_yocto numeric default null,
  p_weekly_limit_yocto numeric default null,
  p_allowed_recipients text[] default null,
  p_actor_agent_id text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_policy public.agent_policies%rowtype; v_recipient text;
begin
  if p_actor_agent_id is null or p_agent_id is null then raise exception 'invalid_policy_update'; end if;
  perform 1 from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  if (p_max_transfer_yocto is not null and (p_max_transfer_yocto <= 0 or p_max_transfer_yocto <> pg_catalog.trunc(p_max_transfer_yocto)))
   or (p_daily_limit_yocto is not null and (p_daily_limit_yocto <= 0 or p_daily_limit_yocto <> pg_catalog.trunc(p_daily_limit_yocto)))
   or (p_weekly_limit_yocto is not null and (p_weekly_limit_yocto <= 0 or p_weekly_limit_yocto <> pg_catalog.trunc(p_weekly_limit_yocto))) then
    raise exception 'invalid_policy_limit';
  end if;
  if not exists(select 1 from public.agents where id=p_agent_id) then raise exception 'agent_not_found'; end if;
  if p_allowed_recipients is not null then
    foreach v_recipient in array p_allowed_recipients loop
      if v_recipient is null or pg_catalog.length(v_recipient) > 64
       or v_recipient !~ '^[a-z0-9]+([._-][a-z0-9]+)*$' then
        raise exception 'invalid_allowed_recipient';
      end if;
    end loop;
  end if;
  insert into public.agent_policies(agent_id,max_transfer_yocto,daily_limit_yocto,weekly_limit_yocto,allowed_recipients,updated_at,updated_by)
  values(p_agent_id,p_max_transfer_yocto,p_daily_limit_yocto,p_weekly_limit_yocto,p_allowed_recipients,pg_catalog.now(),p_actor_agent_id)
  on conflict(agent_id) do update set
    max_transfer_yocto=excluded.max_transfer_yocto,
    daily_limit_yocto=excluded.daily_limit_yocto,
    weekly_limit_yocto=excluded.weekly_limit_yocto,
    allowed_recipients=excluded.allowed_recipients,
    updated_at=excluded.updated_at, updated_by=excluded.updated_by
  returning * into v_policy;
  insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
  values(p_actor_agent_id,'agent_policy_updated',p_agent_id,
    pg_catalog.jsonb_build_object('max_transfer_yocto',v_policy.max_transfer_yocto::text,
      'daily_limit_yocto',v_policy.daily_limit_yocto::text,
      'weekly_limit_yocto',v_policy.weekly_limit_yocto::text,
      'allowed_recipients',v_policy.allowed_recipients));
  return pg_catalog.jsonb_build_object('agent_id',p_agent_id,
    'max_transfer_yocto',v_policy.max_transfer_yocto::text,
    'daily_limit_yocto',v_policy.daily_limit_yocto::text,
    'weekly_limit_yocto',v_policy.weekly_limit_yocto::text,
    'allowed_recipients',v_policy.allowed_recipients);
end;
$$;

create or replace function public.consume_agentguard_rate_limit(
  p_actor_key text,p_action_key text,p_limit integer,p_window_seconds integer default 60
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_start timestamptz; v_count integer;
begin
  if p_actor_key is null or p_action_key is null or p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid_rate_limit_parameters';
  end if;
  v_start := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from pg_catalog.now()) / p_window_seconds) * p_window_seconds);
  insert into public.agentguard_rate_windows(actor_key,action_key,window_start,request_count)
  values(p_actor_key,p_action_key,v_start,1)
  on conflict(actor_key,action_key,window_start)
  do update set request_count=public.agentguard_rate_windows.request_count+1
  returning request_count into v_count;
  return pg_catalog.jsonb_build_object('allowed',v_count<=p_limit,'count',v_count,'limit',p_limit,
    'retry_after_seconds',greatest(1,pg_catalog.ceil(extract(epoch from
      (v_start + pg_catalog.make_interval(secs=>p_window_seconds) - pg_catalog.now())))::integer));
end;
$$;

create or replace function public.reserve_agent_spend(
  p_request_id text,p_amount_yocto numeric,p_recipient text,p_agent_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_budget public.agent_budgets%rowtype;
  v_existing public.spend_reservations%rowtype;
  v_policy public.agent_policies%rowtype;
  v_active boolean; v_enabled boolean;
  v_daily numeric; v_weekly numeric;
begin
  if p_request_id is null or pg_catalog.length(p_request_id)<8 then raise exception 'invalid_request_id'; end if;
  if p_amount_yocto is null or p_amount_yocto<=0 or p_amount_yocto>=1e78
    or p_amount_yocto<>pg_catalog.trunc(p_amount_yocto) then raise exception 'invalid_amount'; end if;
  select active into v_active from public.agents where id=p_agent_id for share;
  if not coalesce(v_active,false) then raise exception 'agent_not_active'; end if;
  select * into v_budget from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select * into v_existing from public.spend_reservations where request_id=p_request_id for update;
  if found then
    if v_existing.amount_yocto<>p_amount_yocto or v_existing.recipient<>p_recipient or v_existing.agent_id<>p_agent_id then
      raise exception 'idempotency_key_conflict';
    end if;
    return pg_catalog.jsonb_build_object('created',false,'status',v_existing.status,'request_id',p_request_id,'agent_id',p_agent_id);
  end if;
  select transfers_enabled into v_enabled from public.agentguard_system_controls where id='default' for share;
  if not coalesce(v_enabled,false) then return pg_catalog.jsonb_build_object('created',false,'status','blocked','reason','emergency_stop'); end if;
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
  if v_budget.spent_yocto+v_budget.reserved_yocto+p_amount_yocto>v_budget.total_limit_yocto then
    return pg_catalog.jsonb_build_object('created',false,'status','blocked','reason','total_budget_exceeded');
  end if;
  insert into public.spend_reservations(request_id,amount_yocto,recipient,status,agent_id,approval_expires_at)
  values(p_request_id,p_amount_yocto,p_recipient,'awaiting_approval',p_agent_id,pg_catalog.now()+interval '15 minutes');
  update public.agent_budgets set reserved_yocto=reserved_yocto+p_amount_yocto,updated_at=pg_catalog.now() where id='default';
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
  v_policy public.agent_policies%rowtype;
  v_enabled boolean; v_active boolean; v_daily numeric; v_weekly numeric;
begin
  if p_actor_agent_id is null then raise exception 'invalid_approval_actor'; end if;
  perform 1 from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select transfers_enabled into v_enabled from public.agentguard_system_controls where id='default' for share;
  if not coalesce(v_enabled,false) then raise exception 'emergency_stop'; end if;
  select * into v_reservation from public.spend_reservations where request_id=p_request_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if v_reservation.status<>'awaiting_approval' or v_reservation.submission_claimed_at is not null then raise exception 'approval_not_pending'; end if;
  if v_reservation.approval_expires_at is null or v_reservation.approval_expires_at<=pg_catalog.now() then raise exception 'approval_expired'; end if;
  select active into v_active from public.agents where id=v_reservation.agent_id for share;
  if not coalesce(v_active,false) then raise exception 'agent_not_active'; end if;
  select * into v_policy from public.agent_policies where agent_id=v_reservation.agent_id for share;
  if not found then raise exception 'agent_policy_not_configured'; end if;
  if v_policy.max_transfer_yocto is not null and v_reservation.amount_yocto>v_policy.max_transfer_yocto then raise exception 'agent_per_transfer_limit'; end if;
  if v_policy.allowed_recipients is not null and not (v_reservation.recipient=any(v_policy.allowed_recipients)) then raise exception 'recipient_not_allowed'; end if;
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

create or replace function public.reject_agent_transfer(p_request_id text,p_actor_agent_id text,p_reason text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_reservation public.spend_reservations%rowtype;
begin
  if p_actor_agent_id is null or p_reason is null or pg_catalog.length(pg_catalog.btrim(p_reason))<3 then
    raise exception 'invalid_rejection';
  end if;
  perform 1 from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select * into v_reservation from public.spend_reservations where request_id=p_request_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if v_reservation.status<>'awaiting_approval' or v_reservation.submission_claimed_at is not null then raise exception 'approval_not_pending'; end if;
  update public.agent_budgets set reserved_yocto=reserved_yocto-v_reservation.amount_yocto,updated_at=pg_catalog.now() where id='default';
  update public.spend_reservations set status='rejected',rejected_at=pg_catalog.now(),rejected_by=p_actor_agent_id,
    approval_reason=pg_catalog.left(p_reason,500),updated_at=pg_catalog.now() where request_id=p_request_id;
  insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
  values(p_actor_agent_id,'transfer_rejected',p_request_id,pg_catalog.jsonb_build_object('agent_id',v_reservation.agent_id,'reason',pg_catalog.left(p_reason,500)));
  return pg_catalog.jsonb_build_object('request_id',p_request_id,'status','rejected');
end;
$$;

create or replace function public.claim_agent_transfer_submission(p_request_id text,p_agent_id text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_reservation public.spend_reservations%rowtype; v_enabled boolean;
begin
  perform 1 from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select transfers_enabled into v_enabled from public.agentguard_system_controls where id='default' for share;
  if not coalesce(v_enabled,false) then return pg_catalog.jsonb_build_object('claimed',false,'reason','emergency_stop'); end if;
  select * into v_reservation from public.spend_reservations
  where request_id=p_request_id and agent_id=p_agent_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if v_reservation.status<>'reserved' or v_reservation.submission_claimed_at is not null then
    return pg_catalog.jsonb_build_object('claimed',false,'reason','already_claimed_or_processed');
  end if;
  update public.spend_reservations set submission_claimed_at=pg_catalog.now(),updated_at=pg_catalog.now() where request_id=p_request_id;
  return pg_catalog.jsonb_build_object('claimed',true,'request_id',p_request_id);
end;
$$;

create or replace function public.rotate_agent_credential(p_agent_id text,p_token_hash text,p_actor_agent_id text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_agent public.agents%rowtype;
begin
  if p_agent_id is null or p_agent_id='primary' or p_token_hash is null
    or p_token_hash !~ '^[a-f0-9]{64}$' or p_actor_agent_id is null then raise exception 'invalid_agent_rotation'; end if;
  perform 1 from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  update public.agents set token_hash=p_token_hash where id=p_agent_id and active=true returning * into v_agent;
  if not found then raise exception 'active_agent_not_found'; end if;
  insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
  values(p_actor_agent_id,'agent_credential_rotated',p_agent_id,pg_catalog.jsonb_build_object('name',v_agent.name));
  return pg_catalog.jsonb_build_object('id',v_agent.id,'name',v_agent.name);
end;
$$;

revoke all on function public.set_agentguard_transfers_enabled(boolean,text) from public,anon,authenticated;
revoke all on function public.set_agent_policy(text,numeric,numeric,numeric,text[],text) from public,anon,authenticated;
revoke all on function public.consume_agentguard_rate_limit(text,text,integer,integer) from public,anon,authenticated;
revoke all on function public.reserve_agent_spend(text,numeric,text,text) from public,anon,authenticated;
revoke all on function public.approve_agent_transfer(text,text) from public,anon,authenticated;
revoke all on function public.reject_agent_transfer(text,text,text) from public,anon,authenticated;
revoke all on function public.claim_agent_transfer_submission(text,text) from public,anon,authenticated;
revoke all on function public.rotate_agent_credential(text,text,text) from public,anon,authenticated;
grant execute on function public.set_agentguard_transfers_enabled(boolean,text) to service_role;
grant execute on function public.set_agent_policy(text,numeric,numeric,numeric,text[],text) to service_role;
grant execute on function public.consume_agentguard_rate_limit(text,text,integer,integer) to service_role;
grant execute on function public.reserve_agent_spend(text,numeric,text,text) to service_role;
grant execute on function public.approve_agent_transfer(text,text) to service_role;
grant execute on function public.reject_agent_transfer(text,text,text) to service_role;
grant execute on function public.claim_agent_transfer_submission(text,text) to service_role;
grant execute on function public.rotate_agent_credential(text,text,text) to service_role;
