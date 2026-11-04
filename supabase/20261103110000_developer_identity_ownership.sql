begin;

alter table public.agents
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null;

create index if not exists agents_owner_user_id_created_at_idx
  on public.agents(owner_user_id, created_at desc)
  where owner_user_id is not null;

create or replace function public.create_developer_agent(
  p_owner_user_id uuid,
  p_agent_id text,
  p_name text,
  p_token_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent public.agents%rowtype;
begin
  if p_owner_user_id is null
    or p_agent_id is null
    or p_agent_id !~ '^[a-z0-9_-]{2,48}$'
    or p_agent_id in ('admin', 'primary')
    or p_name is null
    or pg_catalog.length(pg_catalog.btrim(p_name)) < 2
    or pg_catalog.length(pg_catalog.btrim(p_name)) > 80
    or p_token_hash is null
    or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_developer_agent';
  end if;

  insert into public.agents(id, name, token_hash, active, owner_user_id)
  values (p_agent_id, pg_catalog.btrim(p_name), p_token_hash, true, p_owner_user_id)
  returning * into v_agent;

  insert into public.agent_allocations(agent_id, allocation_limit_yocto, spent_yocto, reserved_yocto, updated_by)
  values (p_agent_id, 0, 0, 0, 'developer:' || p_owner_user_id::text);

  insert into public.agent_policies(agent_id, updated_by)
  values (p_agent_id, 'developer:' || p_owner_user_id::text);

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (
    'developer:' || p_owner_user_id::text,
    'developer_agent_created',
    p_agent_id,
    pg_catalog.jsonb_build_object('owner_user_id', p_owner_user_id::text)
  );

  return pg_catalog.jsonb_build_object(
    'id', v_agent.id,
    'name', v_agent.name,
    'active', v_agent.active,
    'created_at', v_agent.created_at
  );
end;
$$;

create or replace function public.rotate_developer_agent_credential(
  p_owner_user_id uuid,
  p_agent_id text,
  p_token_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent public.agents%rowtype;
begin
  if p_owner_user_id is null or p_agent_id is null
    or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_developer_agent_rotation';
  end if;

  update public.agents
  set token_hash = p_token_hash
  where id = p_agent_id and owner_user_id = p_owner_user_id and active = true
  returning * into v_agent;

  if not found then raise exception 'developer_agent_not_found_or_inactive'; end if;

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (
    'developer:' || p_owner_user_id::text,
    'developer_agent_credential_rotated',
    p_agent_id,
    '{}'::jsonb
  );

  return pg_catalog.jsonb_build_object('id', v_agent.id, 'name', v_agent.name);
end;
$$;

create or replace function public.set_developer_agent_active(
  p_owner_user_id uuid,
  p_agent_id text,
  p_active boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent public.agents%rowtype;
begin
  if p_owner_user_id is null or p_agent_id is null or p_active is null then
    raise exception 'invalid_developer_agent_status';
  end if;

  update public.agents
  set active = p_active
  where id = p_agent_id and owner_user_id = p_owner_user_id
    and id not in ('admin', 'primary')
  returning * into v_agent;

  if not found then raise exception 'developer_agent_not_found'; end if;

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values (
    'developer:' || p_owner_user_id::text,
    case when p_active then 'developer_agent_activated' else 'developer_agent_deactivated' end,
    p_agent_id,
    '{}'::jsonb
  );

  return pg_catalog.jsonb_build_object('id', v_agent.id, 'name', v_agent.name, 'active', v_agent.active);
end;
$$;

revoke all on function public.create_developer_agent(uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.rotate_developer_agent_credential(uuid,text,text) from public, anon, authenticated;
revoke all on function public.set_developer_agent_active(uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.create_developer_agent(uuid,text,text,text) to service_role;
grant execute on function public.rotate_developer_agent_credential(uuid,text,text) to service_role;
grant execute on function public.set_developer_agent_active(uuid,text,boolean) to service_role;

commit;
