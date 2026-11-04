-- Reproducible database-level test for the developer-owned agent workflow.
-- Run in the Supabase SQL editor with a role allowed to insert auth.users.
-- All fixtures and reservations are rolled back at the end.
begin;

create temporary table encu_test_results (
  name text primary key,
  passed boolean not null,
  detail jsonb
);

do $$
declare
  v_owner uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_agent text := 'e2e' || replace(gen_random_uuid()::text, '-', '');
  v_result jsonb;
  v_status text;
begin
  insert into auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v_owner, 'authenticated', 'authenticated', v_owner::text || '@encu-test.invalid', '', pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now());

  insert into auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v_other, 'authenticated', 'authenticated', v_other::text || '@encu-test.invalid', '', pg_catalog.now(), '{}'::jsonb, '{}'::jsonb, pg_catalog.now(), pg_catalog.now());

  v_result := public.create_developer_agent(v_owner, v_agent, 'E2E Test Agent', repeat('a', 64));
  insert into pg_temp.encu_test_results values ('agent_create', v_result->>'id'=v_agent, v_result);

  perform public.developer_set_agent_allocation(v_owner, v_agent, 1000000000000000000000000);
  perform public.developer_set_agent_policy(v_owner, v_agent, 100000000000000000000000, 1000000000000000000000000, 1000000000000000000000000);
  perform public.developer_set_agent_auto_spend_limit(v_owner, v_agent, 0);
  perform public.developer_authorize_agent_recipient(v_owner, v_agent, 'e2e-test.near', 'E2E recipient', null);

  select status into v_status from public.agent_authorized_recipients
   where agent_id=v_agent and account_id='e2e-test.near';
  insert into pg_temp.encu_test_results values ('recipient_authorize', v_status='active', jsonb_build_object('status',v_status));

  v_result := public.reserve_agent_spend('e2e-denied-' || substr(v_agent,4,20), 1, 'e2e-test.near', v_agent);
  insert into pg_temp.encu_test_results values ('out_of_policy_rejected', v_result->>'status'='blocked' and v_result->>'reason'='autonomous_allowance_exceeded', v_result);

  perform public.developer_set_agent_auto_spend_limit(v_owner, v_agent, 10);
  v_result := public.reserve_agent_spend('e2e-allowed-' || substr(v_agent,4,20), 1, 'e2e-test.near', v_agent);
  insert into pg_temp.encu_test_results values ('within_policy_reserved', v_result->>'status'='reserved' and v_result->>'auto_approved'='true', v_result);

  perform public.developer_revoke_agent_recipient(v_owner, v_agent, 'e2e-test.near', 'E2E test revoke');
  select status into v_status from public.agent_authorized_recipients
   where agent_id=v_agent and account_id='e2e-test.near';
  insert into pg_temp.encu_test_results values ('recipient_revoke', v_status='revoked', jsonb_build_object('status',v_status));

  begin
    perform public.developer_set_agent_allocation(v_other, v_agent, 0);
    insert into pg_temp.encu_test_results values ('cross_owner_denied', false, '{}'::jsonb);
  exception when others then
    if sqlerrm='developer_agent_not_found' then
      insert into pg_temp.encu_test_results values ('cross_owner_denied', true, jsonb_build_object('error',sqlerrm));
    else
      raise;
    end if;
  end;
end $$;

select name, passed, detail from pg_temp.encu_test_results order by name;
rollback;
