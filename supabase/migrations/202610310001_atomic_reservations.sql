-- AgentGuard atomic reservation migration.
-- Apply this to a fresh Supabase project after the base schema, or use this file as the complete schema for the hackathon demo.

alter table public.agent_budgets
  add column if not exists total_limit_yocto numeric(78,0);

update public.agent_budgets
set total_limit_yocto = daily_limit_yocto
where total_limit_yocto is null;

alter table public.agent_budgets
  alter column total_limit_yocto set not null;

alter table public.spend_reservations
  add column if not exists last_error text;

alter table public.spend_reservations
  drop constraint if exists spend_reservations_status_check;

alter table public.spend_reservations
  add constraint spend_reservations_status_check
  check (status in ('reserved','executed','failed','needs_review'));

create or replace function public.reserve_agent_spend(
  p_request_id text,
  p_amount_yocto numeric,
  p_recipient text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.agent_budgets%rowtype;
  r public.spend_reservations%rowtype;
begin
  if p_amount_yocto <= 0 then raise exception 'amount_must_be_positive'; end if;

  select * into b from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  select * into r from public.spend_reservations where request_id = p_request_id;
  if found then
    if r.amount_yocto <> p_amount_yocto or r.recipient <> p_recipient then
      raise exception 'idempotency_key_conflict';
    end if;
    return jsonb_build_object('created', false, 'status', r.status, 'request_id', r.request_id);
  end if;

  if b.spent_yocto + b.reserved_yocto + p_amount_yocto > b.total_limit_yocto then
    return jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'budget_exceeded');
  end if;

  insert into public.spend_reservations(request_id, amount_yocto, recipient, status)
  values(p_request_id, p_amount_yocto, p_recipient, 'reserved');

  update public.agent_budgets
  set reserved_yocto = reserved_yocto + p_amount_yocto, updated_at = now()
  where id = 'default';

  return jsonb_build_object('created', true, 'status', 'reserved', 'request_id', p_request_id);
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
  r public.spend_reservations%rowtype;
begin
  if p_outcome not in ('executed','failed','needs_review') then
    raise exception 'invalid_outcome';
  end if;

  select * into r from public.spend_reservations where request_id = p_request_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if r.status <> 'reserved' then
    return jsonb_build_object('status', r.status, 'request_id', p_request_id);
  end if;

  if p_outcome = 'executed' then
    update public.agent_budgets
    set reserved_yocto = reserved_yocto - r.amount_yocto,
        spent_yocto = spent_yocto + r.amount_yocto, updated_at = now()
    where id = 'default';
  elsif p_outcome = 'failed' then
    update public.agent_budgets
    set reserved_yocto = reserved_yocto - r.amount_yocto, updated_at = now()
    where id = 'default';
  end if;
  -- needs_review intentionally retains the reservation until reconciliation.

  update public.spend_reservations
  set status = p_outcome,
      outlayer_tx_hash = coalesce(p_tx_hash, outlayer_tx_hash),
      last_error = p_error,
      updated_at = now()
  where request_id = p_request_id;

  return jsonb_build_object('status', p_outcome, 'request_id', p_request_id);
end;
$$;

revoke all on function public.reserve_agent_spend(text,numeric,text) from public;
revoke all on function public.finish_agent_spend(text,text,text,text) from public;
grant execute on function public.reserve_agent_spend(text,numeric,text) to service_role;
grant execute on function public.finish_agent_spend(text,text,text,text) to service_role;
