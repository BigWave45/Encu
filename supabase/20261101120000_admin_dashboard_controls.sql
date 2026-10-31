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
