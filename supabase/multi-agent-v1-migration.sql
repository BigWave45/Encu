-- Multi-agent V1 migration. Apply once to the existing Supabase database.
-- Existing reservations are attributed to the primary agent; shared budget remains unchanged.
create table if not exists public.agents (
  id text primary key,
  name text not null,
  token_hash text unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.agents (id, name, active) values
  ('primary', 'Primary Agent', true)
on conflict (id) do nothing;
alter table public.spend_reservations add column if not exists agent_id text;
update public.spend_reservations set agent_id = 'primary' where agent_id is null;
alter table public.spend_reservations alter column agent_id set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'spend_reservations_agent_id_fkey') then
    alter table public.spend_reservations add constraint spend_reservations_agent_id_fkey foreign key (agent_id) references public.agents(id);
  end if;
end $$;
create index if not exists spend_reservations_agent_id_created_at_idx on public.spend_reservations (agent_id, created_at desc);
create or replace function public.reserve_agent_spend(p_request_id text, p_amount_yocto numeric, p_recipient text, p_agent_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare budget public.agent_budgets%rowtype; existing public.spend_reservations%rowtype; agent_active boolean;
begin
  if p_request_id is null or length(p_request_id) < 8 then raise exception 'invalid_request_id'; end if;
  if p_amount_yocto is null or p_amount_yocto <= 0 or p_amount_yocto > 1e78 then raise exception 'invalid_amount'; end if;
  select active into agent_active from public.agents where id = p_agent_id;
  if not coalesce(agent_active, false) then raise exception 'agent_not_active'; end if;
  select * into budget from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;
  select * into existing from public.spend_reservations where request_id = p_request_id for update;
  if found then
    if existing.amount_yocto <> p_amount_yocto or existing.recipient <> p_recipient or existing.agent_id <> p_agent_id then raise exception 'idempotency_key_conflict'; end if;
    return jsonb_build_object('created', false, 'status', existing.status, 'request_id', existing.request_id, 'agent_id', existing.agent_id);
  end if;
  if budget.spent_yocto + budget.reserved_yocto + p_amount_yocto > budget.total_limit_yocto then
    return jsonb_build_object('created', false, 'status', 'blocked', 'reason', 'total_budget_exceeded');
  end if;
  insert into public.spend_reservations (request_id, amount_yocto, recipient, status, agent_id) values (p_request_id, p_amount_yocto, p_recipient, 'reserved', p_agent_id);
  update public.agent_budgets set reserved_yocto = reserved_yocto + p_amount_yocto, updated_at = now() where id = 'default';
  return jsonb_build_object('created', true, 'status', 'reserved', 'request_id', p_request_id, 'agent_id', p_agent_id);
end;
$$;
revoke all on function public.reserve_agent_spend(text, numeric, text, text) from public;
grant execute on function public.reserve_agent_spend(text, numeric, text, text) to service_role;
alter table public.agents enable row level security;
