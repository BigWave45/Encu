-- Phase 1: introduce the per-agent allocation ledger and backfill historical exposure.
-- Additive schema only. Enforcement is installed by 20261103010000_enforce_agent_allocations.sql.
begin;

do $preflight$
declare
  v_budget public.agent_budgets%rowtype;
  v_spent numeric;
  v_reserved numeric;
  v_unknown bigint;
begin
  select * into v_budget from public.agent_budgets where id='default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  select
    coalesce(sum(amount_yocto) filter(where status='executed'),0),
    coalesce(sum(amount_yocto) filter(where status in ('awaiting_approval','reserved','needs_review')),0),
    count(*) filter(where status not in ('awaiting_approval','reserved','needs_review','executed','failed','rejected','cancelled'))
  into v_spent,v_reserved,v_unknown
  from public.spend_reservations;

  if v_unknown<>0 then raise exception 'allocation_backfill_unknown_reservation_statuses: %',v_unknown; end if;
  if v_spent<>v_budget.spent_yocto or v_reserved<>v_budget.reserved_yocto then
    raise exception 'allocation_backfill_treasury_ledger_mismatch';
  end if;
end;
$preflight$;

create table public.agent_allocations (
  agent_id text primary key references public.agents(id) on delete restrict,
  allocation_limit_yocto numeric(78,0) not null default 0
    check(allocation_limit_yocto>=0 and allocation_limit_yocto=trunc(allocation_limit_yocto)),
  spent_yocto numeric(78,0) not null default 0
    check(spent_yocto>=0 and spent_yocto=trunc(spent_yocto)),
  reserved_yocto numeric(78,0) not null default 0
    check(reserved_yocto>=0 and reserved_yocto=trunc(reserved_yocto)),
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint agent_allocations_not_overcommitted
    check(spent_yocto+reserved_yocto<=allocation_limit_yocto)
);

insert into public.agent_allocations(agent_id,allocation_limit_yocto,spent_yocto,reserved_yocto)
select a.id,coalesce(r.spent,0)+coalesce(r.reserved,0),coalesce(r.spent,0),coalesce(r.reserved,0)
from public.agents a
left join (
  select agent_id,
    coalesce(sum(amount_yocto) filter(where status='executed'),0) as spent,
    coalesce(sum(amount_yocto) filter(where status in ('awaiting_approval','reserved','needs_review')),0) as reserved
  from public.spend_reservations group by agent_id
) r on r.agent_id=a.id;

alter table public.agent_allocations enable row level security;
revoke all on public.agent_allocations from public,anon,authenticated,service_role;
grant select on public.agent_allocations to service_role;

commit;
