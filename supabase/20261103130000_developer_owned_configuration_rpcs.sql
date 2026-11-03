-- Developer configuration RPCs.
-- Ownership is checked and locked in the same transaction as each mutation.
-- These wrappers are callable only by the server-side service role.
begin;

create or replace function public.developer_set_agent_policy(
  p_owner_user_id uuid,
  p_agent_id text,
  p_max_transfer_yocto numeric,
  p_daily_limit_yocto numeric,
  p_weekly_limit_yocto numeric
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if p_owner_user_id is null then raise exception 'developer_authentication_required'; end if;
  perform 1 from public.agents
   where id = p_agent_id and owner_user_id = p_owner_user_id
   for update;
  if not found then raise exception 'developer_agent_not_found'; end if;
  return public.set_agent_policy(
    p_agent_id, p_max_transfer_yocto, p_daily_limit_yocto,
    p_weekly_limit_yocto, null, 'developer:' || p_owner_user_id::text
  );
end;
$$;

create or replace function public.developer_set_agent_allocation(
  p_owner_user_id uuid, p_agent_id text, p_allocation_limit_yocto numeric
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if p_owner_user_id is null then raise exception 'developer_authentication_required'; end if;
  perform 1 from public.agents
   where id = p_agent_id and owner_user_id = p_owner_user_id
   for update;
  if not found then raise exception 'developer_agent_not_found'; end if;
  return public.set_agent_allocation(
    p_agent_id, p_allocation_limit_yocto, 'developer:' || p_owner_user_id::text
  );
end;
$$;

create or replace function public.developer_set_agent_auto_spend_limit(
  p_owner_user_id uuid, p_agent_id text, p_auto_spend_limit_yocto numeric
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if p_owner_user_id is null then raise exception 'developer_authentication_required'; end if;
  perform 1 from public.agents
   where id = p_agent_id and owner_user_id = p_owner_user_id
   for update;
  if not found then raise exception 'developer_agent_not_found'; end if;
  return public.set_agent_auto_spend_limit(
    p_agent_id, p_auto_spend_limit_yocto, 'developer:' || p_owner_user_id::text
  );
end;
$$;

create or replace function public.developer_authorize_agent_recipient(
  p_owner_user_id uuid, p_agent_id text, p_account_id text,
  p_label text, p_expires_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if p_owner_user_id is null then raise exception 'developer_authentication_required'; end if;
  perform 1 from public.agents
   where id = p_agent_id and owner_user_id = p_owner_user_id
   for update;
  if not found then raise exception 'developer_agent_not_found'; end if;
  return public.authorize_agent_recipient(
    p_agent_id, p_account_id, p_label, p_expires_at, 'developer:' || p_owner_user_id::text
  );
end;
$$;

create or replace function public.developer_revoke_agent_recipient(
  p_owner_user_id uuid, p_agent_id text, p_account_id text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if p_owner_user_id is null then raise exception 'developer_authentication_required'; end if;
  perform 1 from public.agents
   where id = p_agent_id and owner_user_id = p_owner_user_id
   for update;
  if not found then raise exception 'developer_agent_not_found'; end if;
  return public.revoke_agent_recipient(
    p_agent_id, p_account_id, p_reason, 'developer:' || p_owner_user_id::text
  );
end;
$$;

revoke all on function public.developer_set_agent_policy(uuid,text,numeric,numeric,numeric) from public, anon, authenticated;
revoke all on function public.developer_set_agent_allocation(uuid,text,numeric) from public, anon, authenticated;
revoke all on function public.developer_set_agent_auto_spend_limit(uuid,text,numeric) from public, anon, authenticated;
revoke all on function public.developer_authorize_agent_recipient(uuid,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.developer_revoke_agent_recipient(uuid,text,text,text) from public, anon, authenticated;

grant execute on function public.developer_set_agent_policy(uuid,text,numeric,numeric,numeric) to service_role;
grant execute on function public.developer_set_agent_allocation(uuid,text,numeric) to service_role;
grant execute on function public.developer_set_agent_auto_spend_limit(uuid,text,numeric) to service_role;
grant execute on function public.developer_authorize_agent_recipient(uuid,text,text,text,timestamptz) to service_role;
grant execute on function public.developer_revoke_agent_recipient(uuid,text,text,text) to service_role;

commit;
