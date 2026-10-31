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
