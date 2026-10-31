create table if not exists public.agent_budgets (
  id text primary key,
  daily_limit_yocto numeric(78, 0) not null check (daily_limit_yocto >= 0),
  spent_yocto numeric(78, 0) not null default 0 check (spent_yocto >= 0),
  reserved_yocto numeric(78, 0) not null default 0 check (reserved_yocto >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.spend_reservations (
  request_id text primary key,
  amount_yocto numeric(78, 0) not null check (amount_yocto > 0),
  recipient text not null,
  status text not null check (status in ('reserved', 'executed', 'released')),
  outlayer_tx_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.agent_budgets (id, daily_limit_yocto)
values ('default', 5000000000000000000000000)
on conflict (id) do nothing;

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
  budget public.agent_budgets%rowtype;
  existing public.spend_reservations%rowtype;
begin
  if p_amount_yocto <= 0 then
    raise exception 'amount_must_be_positive';
  end if;

  select * into existing
  from public.spend_reservations
  where request_id = p_request_id;

  if found then
    if existing.amount_yocto <> p_amount_yocto or existing.recipient <> p_recipient then
      raise exception 'idempotency_key_conflict';
    end if;
    return jsonb_build_object('status', existing.status, 'request_id', existing.request_id);
  end if;

  select * into budget
  from public.agent_budgets
  where id = 'default'
  for update;

  if not found then
    raise exception 'budget_not_configured';
  end if;

  if budget.spent_yocto + budget.reserved_yocto + p_amount_yocto > budget.daily_limit_yocto then
    return jsonb_build_object('status', 'blocked', 'reason', 'daily_budget_exceeded');
  end if;

  insert into public.spend_reservations (request_id, amount_yocto, recipient, status)
  values (p_request_id, p_amount_yocto, p_recipient, 'reserved');

  update public.agent_budgets
  set reserved_yocto = reserved_yocto + p_amount_yocto,
      updated_at = now()
  where id = 'default';

  return jsonb_build_object('status', 'reserved', 'request_id', p_request_id);
end;
$$;

create or replace function public.finish_agent_spend(
  p_request_id text,
  p_success boolean,
  p_tx_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  reservation public.spend_reservations%rowtype;
begin
  select * into reservation
  from public.spend_reservations
  where request_id = p_request_id
  for update;

  if not found then
    raise exception 'reservation_not_found';
  end if;

  if reservation.status <> 'reserved' then
    return jsonb_build_object('status', reservation.status, 'request_id', p_request_id);
  end if;

  if p_success then
    update public.agent_budgets
    set reserved_yocto = reserved_yocto - reservation.amount_yocto,
        spent_yocto = spent_yocto + reservation.amount_yocto,
        updated_at = now()
    where id = 'default';

    update public.spend_reservations
    set status = 'executed', outlayer_tx_hash = p_tx_hash, updated_at = now()
    where request_id = p_request_id;
  else
    update public.agent_budgets
    set reserved_yocto = reserved_yocto - reservation.amount_yocto,
        updated_at = now()
    where id = 'default';

    update public.spend_reservations
    set status = 'released', updated_at = now()
    where request_id = p_request_id;
  end if;

  return jsonb_build_object('status', case when p_success then 'executed' else 'released' end,
                            'request_id', p_request_id);
end;
$$;

revoke all on function public.reserve_agent_spend(text, numeric, text) from public;
revoke all on function public.finish_agent_spend(text, boolean, text) from public;
grant execute on function public.reserve_agent_spend(text, numeric, text) to service_role;
grant execute on function public.finish_agent_spend(text, boolean, text) to service_role;

alter table public.agent_budgets enable row level security;
alter table public.spend_reservations enable row level security;