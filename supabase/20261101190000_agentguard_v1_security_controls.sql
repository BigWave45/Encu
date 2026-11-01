-- AgentGuard V1 controls: emergency stop, per-agent limits, recipient allowlists,
-- and persistent atomic transfer rate limiting.
-- Apply as an additive upgrade. This migration does not reset existing ledger data.

create table if not exists public.agentguard_system_controls (
  id text primary key check (id = 'default'),
  transfers_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Existing installations start in the enabled state to avoid silently changing
-- an already-running testnet installation. Fresh setup below is fail-closed.
insert into public.agentguard_system_controls (id, transfers_enabled)
values ('default', true)
on conflict (id) do nothing;

create table if not exists public.agent_policies (
  agent_id text primary key references public.agents(id) on delete cascade,
  max_transfer_yocto numeric(78,0),
  daily_limit_yocto numeric(78,0),
  weekly_limit_yocto numeric(78,0),
  -- NULL means unrestricted. [] means no recipient is permitted.
  allowed_recipients text[],
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint agent_policies_positive_limits check (
    (max_transfer_yocto is null or max_transfer_yocto > 0) and
    (daily_limit_yocto is null or daily_limit_yocto > 0) and
    (weekly_limit_yocto is null or weekly_limit_yocto > 0)
  )
);

insert into public.agent_policies (agent_id)
select id from public.agents
on conflict (agent_id) do nothing;

create table if not exists public.agentguard_rate_windows (
  actor_key text not null,
  action_key text not null,
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (actor_key, action_key, window_start)
);

create index if not exists agentguard_rate_windows_window_idx
  on public.agentguard_rate_windows (window_start);

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
  p_enabled boolean,
  p_actor_agent_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous boolean;
begin
  if p_enabled is null or p_actor_agent_id is null then
    raise exception 'invalid_control_update';
  end if;

  select transfers_enabled into v_previous
  from public.agentguard_system_controls
  where id = 'default'
  for update;

  if not found then raise exception 'system_controls_not_configured'; end if;

  update public.agentguard_system_controls
  set transfers_enabled = p_enabled,
      updated_at = pg_catalog.now(),
      updated_by = p_actor_agent_id
  where id = 'default';

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (p_actor_agent_id, 'transfers_enabled_changed', 'default',
    pg_catalog.jsonb_build_object('previous', v_previous, 'enabled', p_enabled));

  return pg_catalog.jsonb_build_object('transfers_enabled', p_enabled);
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
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_policy public.agent_policies%rowtype;
begin
  if p_actor_agent_id is null or p_agent_id is null then
    raise exception 'invalid_policy_update';
  end if;
  if (p_max_transfer_yocto is not null and (p_max_transfer_yocto <= 0 or p_max_transfer_yocto <> pg_catalog.trunc(p_max_transfer_yocto)))
     or (p_daily_limit_yocto is not null and (p_daily_limit_yocto <= 0 or p_daily_limit_yocto <> pg_catalog.trunc(p_daily_limit_yocto)))
     or (p_weekly_limit_yocto is not null and (p_weekly_limit_yocto <= 0 or p_weekly_limit_yocto <> pg_catalog.trunc(p_weekly_limit_yocto))) then
    raise exception 'invalid_policy_limit';
  end if;
  if not exists (select 1 from public.agents where id = p_agent_id) then
    raise exception 'agent_not_found';
  end if;
  if p_allowed_recipients is not null and exists (
    select 1 from pg_catalog.unnest(p_allowed_recipients) as recipients(value)
    where value !~ '^[a-z0-9]+([._-][a-z0-9]+)*
  ) then
    raise exception 'invalid_allowed_recipient';
  end if;

  insert into public.agent_policies(
    agent_id, max_transfer_yocto, daily_limit_yocto, weekly_limit_yocto,
    allowed_recipients, updated_at, updated_by
  ) values (
    p_agent_id, p_max_transfer_yocto, p_daily_limit_yocto, p_weekly_limit_yocto,
    p_allowed_recipients, pg_catalog.now(), p_actor_agent_id
  )
  on conflict (agent_id) do update set
    max_transfer_yocto = excluded.max_transfer_yocto,
    daily_limit_yocto = excluded.daily_limit_yocto,
    weekly_limit_yocto = excluded.weekly_limit_yocto,
    allowed_recipients = excluded.allowed_recipients,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
  returning * into v_policy;

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (p_actor_agent_id, 'agent_policy_updated', p_agent_id,
    pg_catalog.jsonb_build_object(
      'max_transfer_yocto', v_policy.max_transfer_yocto::text,
      'daily_limit_yocto', v_policy.daily_limit_yocto::text,
      'weekly_limit_yocto', v_policy.weekly_limit_yocto::text,
      'allowed_recipients', v_policy.allowed_recipients
    ));

  return pg_catalog.jsonb_build_object(
    'agent_id', p_agent_id,
    'max_transfer_yocto', v_policy.max_transfer_yocto::text,
    'daily_limit_yocto', v_policy.daily_limit_yocto::text,
    'weekly_limit_yocto', v_policy.weekly_limit_yocto::text,
    'allowed_recipients', v_policy.allowed_recipients
  );
end;
$$;

-- Fixed UTC minute windows. Upsert/increment is atomic across serverless instances.
create or replace function public.consume_agentguard_rate_limit(
  p_actor_key text,
  p_action_key text,
  p_limit integer,
  p_window_seconds integer default 60
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_count integer;
begin
  if p_actor_key is null or p_action_key is null or p_limit < 1
     or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid_rate_limit_parameters';
  end if;

  v_start := pg_catalog.to_timestamp(
    pg_catalog.floor(pg_catalog.extract(epoch from pg_catalog.now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.agentguard_rate_windows(actor_key, action_key, window_start, request_count)
  values (p_actor_key, p_action_key, v_start, 1)
  on conflict (actor_key, action_key, window_start)
  do update set request_count = public.agentguard_rate_windows.request_count + 1
  returning request_count into v_count;

  return pg_catalog.jsonb_build_object(
    'allowed', v_count <= p_limit,
    'count', v_count,
    'limit', p_limit,
    'retry_after_seconds', greatest(1, pg_catalog.ceil(
      pg_catalog.extract(epoch from (v_start + pg_catalog.make_interval(secs => p_window_seconds) - pg_catalog.now()))
    )::integer)
  );
end;
$$;

alter table public.spend_reservations
  add column if not exists submission_claimed_at timestamptz;

-- The provider call is permitted only after this atomic claim succeeds.
-- The shared budget lock gives the emergency-stop toggle and transfer claims
-- a common serialization point.
create or replace function public.claim_agent_transfer_submission(
  p_request_id text,
  p_agent_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $
declare
  v_enabled boolean;
  v_reservation public.spend_reservations%rowtype;
begin
  perform 1 from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  select transfers_enabled into v_enabled
  from public.agentguard_system_controls where id = 'default' for share;
  if not coalesce(v_enabled, false) then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'emergency_stop');
  end if;

  select * into v_reservation
  from public.spend_reservations
  where request_id = p_request_id and agent_id = p_agent_id
  for update;
  if not found then raise exception 'reservation_not_found'; end if;

  if v_reservation.status <> 'reserved' or v_reservation.submission_claimed_at is not null then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'already_claimed_or_processed');
  end if;

  update public.spend_reservations
  set submission_claimed_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where request_id = p_request_id;

  return pg_catalog.jsonb_build_object('claimed', true, 'request_id', p_request_id);
end;
$;

revoke all on function public.claim_agent_transfer_submission(text,text) from public, anon, authenticated;
grant execute on function public.claim_agent_transfer_submission(text,text) to service_role;

create or replace function public.reserve_agent_spend(
  p_request_id text,
  p_amount_yocto numeric,
  p_recipient text,
  p_agent_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_budget public.agent_budgets%rowtype;
  v_existing public.spend_reservations%rowtype;
  v_agent_active boolean;
  v_policy public.agent_policies%rowtype;
  v_transfers_enabled boolean;
  v_daily_total numeric;
  v_weekly_total numeric;
begin
  if p_request_id is null or pg_catalog.length(p_request_id) < 8 then
    raise exception 'invalid_request_id';
  end if;
  if p_amount_yocto is null or p_amount_yocto <= 0 or p_amount_yocto >= 1e78
     or p_amount_yocto <> pg_catalog.trunc(p_amount_yocto) then
    raise exception 'invalid_amount';
  end if;

  select active into v_agent_active
  from public.agents where id = p_agent_id for share;
  if not coalesce(v_agent_active, false) then raise exception 'agent_not_active'; end if;

  -- Shared budget lock serializes every agent's reservation and therefore
  -- serializes daily/weekly spend calculations as well.
  select * into v_budget from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  select * into v_existing
  from public.spend_reservations where request_id = p_request_id for update;
  if found then
    if v_existing.amount_yocto <> p_amount_yocto
       or v_existing.recipient <> p_recipient
       or v_existing.agent_id <> p_agent_id then
      raise exception 'idempotency_key_conflict';
    end if;
    return pg_catalog.jsonb_build_object(
      'created', false, 'status', v_existing.status,
      'request_id', v_existing.request_id, 'agent_id', v_existing.agent_id
    );
  end if;

  select transfers_enabled into v_transfers_enabled
  from public.agentguard_system_controls where id = 'default' for share;
  if not coalesce(v_transfers_enabled, false) then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'emergency_stop');
  end if;

  select * into v_policy from public.agent_policies where agent_id = p_agent_id;
  if not found then raise exception 'agent_policy_not_configured'; end if;

  if v_policy.max_transfer_yocto is not null and p_amount_yocto > v_policy.max_transfer_yocto then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_per_transfer_limit');
  end if;
  if v_policy.allowed_recipients is not null and not (p_recipient = any(v_policy.allowed_recipients)) then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'recipient_not_allowed');
  end if;

  if v_policy.daily_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_daily_total
    from public.spend_reservations
    where agent_id = p_agent_id
      and created_at >= pg_catalog.now() - interval '24 hours'
      and status in ('reserved', 'needs_review', 'executed');
    if v_daily_total + p_amount_yocto > v_policy.daily_limit_yocto then
      return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_daily_limit');
    end if;
  end if;

  if v_policy.weekly_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_weekly_total
    from public.spend_reservations
    where agent_id = p_agent_id
      and created_at >= pg_catalog.now() - interval '7 days'
      and status in ('reserved', 'needs_review', 'executed');
    if v_weekly_total + p_amount_yocto > v_policy.weekly_limit_yocto then
      return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_weekly_limit');
    end if;
  end if;

  if v_budget.spent_yocto + v_budget.reserved_yocto + p_amount_yocto > v_budget.total_limit_yocto then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'total_budget_exceeded');
  end if;

  insert into public.spend_reservations(request_id, amount_yocto, recipient, status, agent_id)
  values (p_request_id, p_amount_yocto, p_recipient, 'reserved', p_agent_id);
  update public.agent_budgets
  set reserved_yocto = reserved_yocto + p_amount_yocto, updated_at = pg_catalog.now()
  where id = 'default';

  return pg_catalog.jsonb_build_object(
    'created', true, 'status', 'reserved', 'request_id', p_request_id, 'agent_id', p_agent_id
  );
end;
$$;

revoke all on function public.set_agentguard_transfers_enabled(boolean,text) from public, anon, authenticated;
revoke all on function public.set_agent_policy(text,numeric,numeric,numeric,text[],text) from public, anon, authenticated;
revoke all on function public.consume_agentguard_rate_limit(text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.reserve_agent_spend(text,numeric,text,text) from public, anon, authenticated;
grant execute on function public.set_agentguard_transfers_enabled(boolean,text) to service_role;
grant execute on function public.set_agent_policy(text,numeric,numeric,numeric,text[],text) to service_role;
grant execute on function public.consume_agentguard_rate_limit(text,text,integer,integer) to service_role;
grant execute on function public.reserve_agent_spend(text,numeric,text,text) to service_role;

-- Prune old rate windows opportunistically from an admin maintenance action later;
-- this table is intentionally not exposed to anon/authenticated clients.


-- Human approval is required for every transfer in V1. Approval is bound to
-- immutable reservation parameters and consumed atomically before OutLayer.
alter table public.spend_reservations
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
  check (status in ('awaiting_approval', 'reserved', 'executed', 'failed', 'needs_review', 'rejected'));

create or replace function public.reserve_agent_spend(
  p_request_id text,
  p_amount_yocto numeric,
  p_recipient text,
  p_agent_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_budget public.agent_budgets%rowtype;
  v_existing public.spend_reservations%rowtype;
  v_agent_active boolean;
  v_policy public.agent_policies%rowtype;
  v_transfers_enabled boolean;
  v_daily_total numeric;
  v_weekly_total numeric;
begin
  if p_request_id is null or pg_catalog.length(p_request_id) < 8 then raise exception 'invalid_request_id'; end if;
  if p_amount_yocto is null or p_amount_yocto <= 0 or p_amount_yocto >= 1e78
     or p_amount_yocto <> pg_catalog.trunc(p_amount_yocto) then raise exception 'invalid_amount'; end if;

  select active into v_agent_active from public.agents where id = p_agent_id for share;
  if not coalesce(v_agent_active, false) then raise exception 'agent_not_active'; end if;

  select * into v_budget from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  select * into v_existing from public.spend_reservations where request_id = p_request_id for update;
  if found then
    if v_existing.amount_yocto <> p_amount_yocto or v_existing.recipient <> p_recipient or v_existing.agent_id <> p_agent_id then
      raise exception 'idempotency_key_conflict';
    end if;
    return pg_catalog.jsonb_build_object('created', false, 'status', v_existing.status, 'request_id', v_existing.request_id, 'agent_id', v_existing.agent_id);
  end if;

  select transfers_enabled into v_transfers_enabled
  from public.agentguard_system_controls where id = 'default' for share;
  if not coalesce(v_transfers_enabled, false) then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'emergency_stop');
  end if;

  select * into v_policy from public.agent_policies where agent_id = p_agent_id;
  if not found then raise exception 'agent_policy_not_configured'; end if;
  if v_policy.max_transfer_yocto is not null and p_amount_yocto > v_policy.max_transfer_yocto then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_per_transfer_limit');
  end if;
  if v_policy.allowed_recipients is not null and not (p_recipient = any(v_policy.allowed_recipients)) then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'recipient_not_allowed');
  end if;

  if v_policy.daily_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_daily_total
    from public.spend_reservations
    where agent_id = p_agent_id and created_at >= pg_catalog.now() - interval '24 hours'
      and status in ('awaiting_approval', 'reserved', 'needs_review', 'executed');
    if v_daily_total + p_amount_yocto > v_policy.daily_limit_yocto then
      return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_daily_limit');
    end if;
  end if;

  if v_policy.weekly_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_weekly_total
    from public.spend_reservations
    where agent_id = p_agent_id and created_at >= pg_catalog.now() - interval '7 days'
      and status in ('awaiting_approval', 'reserved', 'needs_review', 'executed');
    if v_weekly_total + p_amount_yocto > v_policy.weekly_limit_yocto then
      return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_weekly_limit');
    end if;
  end if;

  if v_budget.spent_yocto + v_budget.reserved_yocto + p_amount_yocto > v_budget.total_limit_yocto then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'total_budget_exceeded');
  end if;

  insert into public.spend_reservations(
    request_id, amount_yocto, recipient, status, agent_id, approval_expires_at
  ) values (
    p_request_id, p_amount_yocto, p_recipient, 'awaiting_approval', p_agent_id, pg_catalog.now() + interval '15 minutes'
  );
  update public.agent_budgets
  set reserved_yocto = reserved_yocto + p_amount_yocto, updated_at = pg_catalog.now()
  where id = 'default';

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (p_agent_id, 'transfer_submitted_for_approval', p_request_id,
    pg_catalog.jsonb_build_object('recipient', p_recipient, 'amount_yocto', p_amount_yocto::text));

  return pg_catalog.jsonb_build_object(
    'created', true, 'status', 'awaiting_approval', 'request_id', p_request_id,
    'agent_id', p_agent_id, 'approval_expires_at', pg_catalog.now() + interval '15 minutes'
  );
end;
$$;

create or replace function public.approve_agent_transfer(
  p_request_id text,
  p_actor_agent_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.spend_reservations%rowtype;
  v_enabled boolean;
  v_active boolean;
begin
  perform 1 from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select transfers_enabled into v_enabled from public.agentguard_system_controls where id = 'default' for share;
  if not coalesce(v_enabled, false) then raise exception 'emergency_stop'; end if;

  select * into v_reservation from public.spend_reservations
  where request_id = p_request_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if v_reservation.status <> 'awaiting_approval' or v_reservation.submission_claimed_at is not null then
    raise exception 'approval_not_pending';
  end if;
  if v_reservation.approval_expires_at is null or v_reservation.approval_expires_at <= pg_catalog.now() then
    raise exception 'approval_expired';
  end if;

  select active into v_active from public.agents where id = v_reservation.agent_id for share;
  if not coalesce(v_active, false) then raise exception 'agent_not_active'; end if;

  update public.spend_reservations
  set status = 'reserved',
      approved_at = pg_catalog.now(),
      approved_by = p_actor_agent_id,
      submission_claimed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where request_id = p_request_id;

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (p_actor_agent_id, 'transfer_approved', p_request_id,
    pg_catalog.jsonb_build_object('agent_id', v_reservation.agent_id,
      'recipient', v_reservation.recipient, 'amount_yocto', v_reservation.amount_yocto::text));

  return pg_catalog.jsonb_build_object(
    'request_id', p_request_id, 'agent_id', v_reservation.agent_id,
    'recipient', v_reservation.recipient, 'amount_yocto', v_reservation.amount_yocto::text,
    'status', 'reserved'
  );
end;
$$;

create or replace function public.reject_agent_transfer(
  p_request_id text,
  p_actor_agent_id text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.spend_reservations%rowtype;
begin
  perform 1 from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select * into v_reservation from public.spend_reservations
  where request_id = p_request_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if v_reservation.status <> 'awaiting_approval' or v_reservation.submission_claimed_at is not null then
    raise exception 'approval_not_pending';
  end if;

  update public.agent_budgets
  set reserved_yocto = reserved_yocto - v_reservation.amount_yocto,
      updated_at = pg_catalog.now()
  where id = 'default';

  update public.spend_reservations
  set status = 'rejected', rejected_at = pg_catalog.now(), rejected_by = p_actor_agent_id,
      approval_reason = pg_catalog.left(p_reason, 500), updated_at = pg_catalog.now()
  where request_id = p_request_id;

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (p_actor_agent_id, 'transfer_rejected', p_request_id,
    pg_catalog.jsonb_build_object('agent_id', v_reservation.agent_id, 'reason', pg_catalog.left(p_reason, 500)));

  return pg_catalog.jsonb_build_object('request_id', p_request_id, 'status', 'rejected');
end;
$$;

revoke all on function public.approve_agent_transfer(text,text) from public, anon, authenticated;
revoke all on function public.reject_agent_transfer(text,text,text) from public, anon, authenticated;
grant execute on function public.approve_agent_transfer(text,text) to service_role;
grant execute on function public.reject_agent_transfer(text,text,text) to service_role;
 or pg_catalog.length(value) > 64
  ) then
    raise exception 'invalid_allowed_recipient';
  end if;

  insert into public.agent_policies(
    agent_id, max_transfer_yocto, daily_limit_yocto, weekly_limit_yocto,
    allowed_recipients, updated_at, updated_by
  ) values (
    p_agent_id, p_max_transfer_yocto, p_daily_limit_yocto, p_weekly_limit_yocto,
    p_allowed_recipients, pg_catalog.now(), p_actor_agent_id
  )
  on conflict (agent_id) do update set
    max_transfer_yocto = excluded.max_transfer_yocto,
    daily_limit_yocto = excluded.daily_limit_yocto,
    weekly_limit_yocto = excluded.weekly_limit_yocto,
    allowed_recipients = excluded.allowed_recipients,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
  returning * into v_policy;

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (p_actor_agent_id, 'agent_policy_updated', p_agent_id,
    pg_catalog.jsonb_build_object(
      'max_transfer_yocto', v_policy.max_transfer_yocto::text,
      'daily_limit_yocto', v_policy.daily_limit_yocto::text,
      'weekly_limit_yocto', v_policy.weekly_limit_yocto::text,
      'allowed_recipients', v_policy.allowed_recipients
    ));

  return pg_catalog.jsonb_build_object(
    'agent_id', p_agent_id,
    'max_transfer_yocto', v_policy.max_transfer_yocto::text,
    'daily_limit_yocto', v_policy.daily_limit_yocto::text,
    'weekly_limit_yocto', v_policy.weekly_limit_yocto::text,
    'allowed_recipients', v_policy.allowed_recipients
  );
end;
$$;

-- Fixed UTC minute windows. Upsert/increment is atomic across serverless instances.
create or replace function public.consume_agentguard_rate_limit(
  p_actor_key text,
  p_action_key text,
  p_limit integer,
  p_window_seconds integer default 60
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_count integer;
begin
  if p_actor_key is null or p_action_key is null or p_limit < 1
     or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid_rate_limit_parameters';
  end if;

  v_start := pg_catalog.to_timestamp(
    pg_catalog.floor(pg_catalog.extract(epoch from pg_catalog.now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.agentguard_rate_windows(actor_key, action_key, window_start, request_count)
  values (p_actor_key, p_action_key, v_start, 1)
  on conflict (actor_key, action_key, window_start)
  do update set request_count = public.agentguard_rate_windows.request_count + 1
  returning request_count into v_count;

  return pg_catalog.jsonb_build_object(
    'allowed', v_count <= p_limit,
    'count', v_count,
    'limit', p_limit,
    'retry_after_seconds', greatest(1, pg_catalog.ceil(
      pg_catalog.extract(epoch from (v_start + pg_catalog.make_interval(secs => p_window_seconds) - pg_catalog.now()))
    )::integer)
  );
end;
$$;

alter table public.spend_reservations
  add column if not exists submission_claimed_at timestamptz;

-- The provider call is permitted only after this atomic claim succeeds.
-- The shared budget lock gives the emergency-stop toggle and transfer claims
-- a common serialization point.
create or replace function public.claim_agent_transfer_submission(
  p_request_id text,
  p_agent_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $
declare
  v_enabled boolean;
  v_reservation public.spend_reservations%rowtype;
begin
  perform 1 from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  select transfers_enabled into v_enabled
  from public.agentguard_system_controls where id = 'default' for share;
  if not coalesce(v_enabled, false) then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'emergency_stop');
  end if;

  select * into v_reservation
  from public.spend_reservations
  where request_id = p_request_id and agent_id = p_agent_id
  for update;
  if not found then raise exception 'reservation_not_found'; end if;

  if v_reservation.status <> 'reserved' or v_reservation.submission_claimed_at is not null then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'already_claimed_or_processed');
  end if;

  update public.spend_reservations
  set submission_claimed_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where request_id = p_request_id;

  return pg_catalog.jsonb_build_object('claimed', true, 'request_id', p_request_id);
end;
$;

revoke all on function public.claim_agent_transfer_submission(text,text) from public, anon, authenticated;
grant execute on function public.claim_agent_transfer_submission(text,text) to service_role;

create or replace function public.reserve_agent_spend(
  p_request_id text,
  p_amount_yocto numeric,
  p_recipient text,
  p_agent_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_budget public.agent_budgets%rowtype;
  v_existing public.spend_reservations%rowtype;
  v_agent_active boolean;
  v_policy public.agent_policies%rowtype;
  v_transfers_enabled boolean;
  v_daily_total numeric;
  v_weekly_total numeric;
begin
  if p_request_id is null or pg_catalog.length(p_request_id) < 8 then
    raise exception 'invalid_request_id';
  end if;
  if p_amount_yocto is null or p_amount_yocto <= 0 or p_amount_yocto >= 1e78
     or p_amount_yocto <> pg_catalog.trunc(p_amount_yocto) then
    raise exception 'invalid_amount';
  end if;

  select active into v_agent_active
  from public.agents where id = p_agent_id for share;
  if not coalesce(v_agent_active, false) then raise exception 'agent_not_active'; end if;

  -- Shared budget lock serializes every agent's reservation and therefore
  -- serializes daily/weekly spend calculations as well.
  select * into v_budget from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  select * into v_existing
  from public.spend_reservations where request_id = p_request_id for update;
  if found then
    if v_existing.amount_yocto <> p_amount_yocto
       or v_existing.recipient <> p_recipient
       or v_existing.agent_id <> p_agent_id then
      raise exception 'idempotency_key_conflict';
    end if;
    return pg_catalog.jsonb_build_object(
      'created', false, 'status', v_existing.status,
      'request_id', v_existing.request_id, 'agent_id', v_existing.agent_id
    );
  end if;

  select transfers_enabled into v_transfers_enabled
  from public.agentguard_system_controls where id = 'default' for share;
  if not coalesce(v_transfers_enabled, false) then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'emergency_stop');
  end if;

  select * into v_policy from public.agent_policies where agent_id = p_agent_id;
  if not found then raise exception 'agent_policy_not_configured'; end if;

  if v_policy.max_transfer_yocto is not null and p_amount_yocto > v_policy.max_transfer_yocto then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_per_transfer_limit');
  end if;
  if v_policy.allowed_recipients is not null and not (p_recipient = any(v_policy.allowed_recipients)) then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'recipient_not_allowed');
  end if;

  if v_policy.daily_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_daily_total
    from public.spend_reservations
    where agent_id = p_agent_id
      and created_at >= pg_catalog.now() - interval '24 hours'
      and status in ('reserved', 'needs_review', 'executed');
    if v_daily_total + p_amount_yocto > v_policy.daily_limit_yocto then
      return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_daily_limit');
    end if;
  end if;

  if v_policy.weekly_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_weekly_total
    from public.spend_reservations
    where agent_id = p_agent_id
      and created_at >= pg_catalog.now() - interval '7 days'
      and status in ('reserved', 'needs_review', 'executed');
    if v_weekly_total + p_amount_yocto > v_policy.weekly_limit_yocto then
      return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_weekly_limit');
    end if;
  end if;

  if v_budget.spent_yocto + v_budget.reserved_yocto + p_amount_yocto > v_budget.total_limit_yocto then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'total_budget_exceeded');
  end if;

  insert into public.spend_reservations(request_id, amount_yocto, recipient, status, agent_id)
  values (p_request_id, p_amount_yocto, p_recipient, 'reserved', p_agent_id);
  update public.agent_budgets
  set reserved_yocto = reserved_yocto + p_amount_yocto, updated_at = pg_catalog.now()
  where id = 'default';

  return pg_catalog.jsonb_build_object(
    'created', true, 'status', 'reserved', 'request_id', p_request_id, 'agent_id', p_agent_id
  );
end;
$$;

revoke all on function public.set_agentguard_transfers_enabled(boolean,text) from public, anon, authenticated;
revoke all on function public.set_agent_policy(text,numeric,numeric,numeric,text[],text) from public, anon, authenticated;
revoke all on function public.consume_agentguard_rate_limit(text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.reserve_agent_spend(text,numeric,text,text) from public, anon, authenticated;
grant execute on function public.set_agentguard_transfers_enabled(boolean,text) to service_role;
grant execute on function public.set_agent_policy(text,numeric,numeric,numeric,text[],text) to service_role;
grant execute on function public.consume_agentguard_rate_limit(text,text,integer,integer) to service_role;
grant execute on function public.reserve_agent_spend(text,numeric,text,text) to service_role;

-- Prune old rate windows opportunistically from an admin maintenance action later;
-- this table is intentionally not exposed to anon/authenticated clients.


-- Human approval is required for every transfer in V1. Approval is bound to
-- immutable reservation parameters and consumed atomically before OutLayer.
alter table public.spend_reservations
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
  check (status in ('awaiting_approval', 'reserved', 'executed', 'failed', 'needs_review', 'rejected'));

create or replace function public.reserve_agent_spend(
  p_request_id text,
  p_amount_yocto numeric,
  p_recipient text,
  p_agent_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_budget public.agent_budgets%rowtype;
  v_existing public.spend_reservations%rowtype;
  v_agent_active boolean;
  v_policy public.agent_policies%rowtype;
  v_transfers_enabled boolean;
  v_daily_total numeric;
  v_weekly_total numeric;
begin
  if p_request_id is null or pg_catalog.length(p_request_id) < 8 then raise exception 'invalid_request_id'; end if;
  if p_amount_yocto is null or p_amount_yocto <= 0 or p_amount_yocto >= 1e78
     or p_amount_yocto <> pg_catalog.trunc(p_amount_yocto) then raise exception 'invalid_amount'; end if;

  select active into v_agent_active from public.agents where id = p_agent_id for share;
  if not coalesce(v_agent_active, false) then raise exception 'agent_not_active'; end if;

  select * into v_budget from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  select * into v_existing from public.spend_reservations where request_id = p_request_id for update;
  if found then
    if v_existing.amount_yocto <> p_amount_yocto or v_existing.recipient <> p_recipient or v_existing.agent_id <> p_agent_id then
      raise exception 'idempotency_key_conflict';
    end if;
    return pg_catalog.jsonb_build_object('created', false, 'status', v_existing.status, 'request_id', v_existing.request_id, 'agent_id', v_existing.agent_id);
  end if;

  select transfers_enabled into v_transfers_enabled
  from public.agentguard_system_controls where id = 'default' for share;
  if not coalesce(v_transfers_enabled, false) then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'emergency_stop');
  end if;

  select * into v_policy from public.agent_policies where agent_id = p_agent_id;
  if not found then raise exception 'agent_policy_not_configured'; end if;
  if v_policy.max_transfer_yocto is not null and p_amount_yocto > v_policy.max_transfer_yocto then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_per_transfer_limit');
  end if;
  if v_policy.allowed_recipients is not null and not (p_recipient = any(v_policy.allowed_recipients)) then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'recipient_not_allowed');
  end if;

  if v_policy.daily_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_daily_total
    from public.spend_reservations
    where agent_id = p_agent_id and created_at >= pg_catalog.now() - interval '24 hours'
      and status in ('awaiting_approval', 'reserved', 'needs_review', 'executed');
    if v_daily_total + p_amount_yocto > v_policy.daily_limit_yocto then
      return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_daily_limit');
    end if;
  end if;

  if v_policy.weekly_limit_yocto is not null then
    select coalesce(sum(amount_yocto), 0) into v_weekly_total
    from public.spend_reservations
    where agent_id = p_agent_id and created_at >= pg_catalog.now() - interval '7 days'
      and status in ('awaiting_approval', 'reserved', 'needs_review', 'executed');
    if v_weekly_total + p_amount_yocto > v_policy.weekly_limit_yocto then
      return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'agent_weekly_limit');
    end if;
  end if;

  if v_budget.spent_yocto + v_budget.reserved_yocto + p_amount_yocto > v_budget.total_limit_yocto then
    return pg_catalog.jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'total_budget_exceeded');
  end if;

  insert into public.spend_reservations(
    request_id, amount_yocto, recipient, status, agent_id, approval_expires_at
  ) values (
    p_request_id, p_amount_yocto, p_recipient, 'awaiting_approval', p_agent_id, pg_catalog.now() + interval '15 minutes'
  );
  update public.agent_budgets
  set reserved_yocto = reserved_yocto + p_amount_yocto, updated_at = pg_catalog.now()
  where id = 'default';

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (p_agent_id, 'transfer_submitted_for_approval', p_request_id,
    pg_catalog.jsonb_build_object('recipient', p_recipient, 'amount_yocto', p_amount_yocto::text));

  return pg_catalog.jsonb_build_object(
    'created', true, 'status', 'awaiting_approval', 'request_id', p_request_id,
    'agent_id', p_agent_id, 'approval_expires_at', pg_catalog.now() + interval '15 minutes'
  );
end;
$$;

create or replace function public.approve_agent_transfer(
  p_request_id text,
  p_actor_agent_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.spend_reservations%rowtype;
  v_enabled boolean;
  v_active boolean;
begin
  perform 1 from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select transfers_enabled into v_enabled from public.agentguard_system_controls where id = 'default' for share;
  if not coalesce(v_enabled, false) then raise exception 'emergency_stop'; end if;

  select * into v_reservation from public.spend_reservations
  where request_id = p_request_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if v_reservation.status <> 'awaiting_approval' or v_reservation.submission_claimed_at is not null then
    raise exception 'approval_not_pending';
  end if;
  if v_reservation.approval_expires_at is null or v_reservation.approval_expires_at <= pg_catalog.now() then
    raise exception 'approval_expired';
  end if;

  select active into v_active from public.agents where id = v_reservation.agent_id for share;
  if not coalesce(v_active, false) then raise exception 'agent_not_active'; end if;

  update public.spend_reservations
  set status = 'reserved',
      approved_at = pg_catalog.now(),
      approved_by = p_actor_agent_id,
      submission_claimed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where request_id = p_request_id;

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (p_actor_agent_id, 'transfer_approved', p_request_id,
    pg_catalog.jsonb_build_object('agent_id', v_reservation.agent_id,
      'recipient', v_reservation.recipient, 'amount_yocto', v_reservation.amount_yocto::text));

  return pg_catalog.jsonb_build_object(
    'request_id', p_request_id, 'agent_id', v_reservation.agent_id,
    'recipient', v_reservation.recipient, 'amount_yocto', v_reservation.amount_yocto::text,
    'status', 'reserved'
  );
end;
$$;

create or replace function public.reject_agent_transfer(
  p_request_id text,
  p_actor_agent_id text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.spend_reservations%rowtype;
begin
  perform 1 from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select * into v_reservation from public.spend_reservations
  where request_id = p_request_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if v_reservation.status <> 'awaiting_approval' or v_reservation.submission_claimed_at is not null then
    raise exception 'approval_not_pending';
  end if;

  update public.agent_budgets
  set reserved_yocto = reserved_yocto - v_reservation.amount_yocto,
      updated_at = pg_catalog.now()
  where id = 'default';

  update public.spend_reservations
  set status = 'rejected', rejected_at = pg_catalog.now(), rejected_by = p_actor_agent_id,
      approval_reason = pg_catalog.left(p_reason, 500), updated_at = pg_catalog.now()
  where request_id = p_request_id;

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (p_actor_agent_id, 'transfer_rejected', p_request_id,
    pg_catalog.jsonb_build_object('agent_id', v_reservation.agent_id, 'reason', pg_catalog.left(p_reason, 500)));

  return pg_catalog.jsonb_build_object('request_id', p_request_id, 'status', 'rejected');
end;
$$;

revoke all on function public.approve_agent_transfer(text,text) from public, anon, authenticated;
revoke all on function public.reject_agent_transfer(text,text,text) from public, anon, authenticated;
grant execute on function public.approve_agent_transfer(text,text) to service_role;
grant execute on function public.reject_agent_transfer(text,text,text) to service_role;


-- Credential rotation and its audit record are one transaction. The raw token
-- is never passed to SQL; only its one-way hash is stored.
create or replace function public.rotate_agent_credential(
  p_agent_id text,
  p_token_hash text,
  p_actor_agent_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent public.agents%rowtype;
begin
  if p_agent_id is null or p_agent_id = 'primary'
     or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_actor_agent_id is null then
    raise exception 'invalid_agent_rotation';
  end if;

  update public.agents
  set token_hash = p_token_hash
  where id = p_agent_id and active = true
  returning * into v_agent;
  if not found then raise exception 'active_agent_not_found'; end if;

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (p_actor_agent_id, 'agent_credential_rotated', p_agent_id,
    pg_catalog.jsonb_build_object('name', v_agent.name));

  return pg_catalog.jsonb_build_object('id', v_agent.id, 'name', v_agent.name);
end;
$$;

revoke all on function public.rotate_agent_credential(text,text,text) from public, anon, authenticated;
grant execute on function public.rotate_agent_credential(text,text,text) to service_role;
