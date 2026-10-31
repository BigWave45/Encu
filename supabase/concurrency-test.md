# Shared-budget concurrency test (NEAR testnet, no transfers)

This is a manual PostgreSQL concurrency test. It calls only the Supabase reservation RPC; it does not call OutLayer or NEAR.

## Preconditions

- Run only against the AgentGuard test database.
- Confirm the current `agent_budgets.total_limit_yocto`, `spent_yocto`, and `reserved_yocto` values for `id = 'default'`.
- Record the exact current `total_limit_yocto` value so it can be restored.
- Use a fresh suffix for the agent IDs and request IDs below if these IDs already exist.
- Use three separate Supabase SQL Editor tabs/sessions: Setup, Lock holder, and two callers (Caller A and Caller B). Caller A and Caller B must be separate database sessions.

## 1. Setup session

Run once and commit. Replace the suffix if needed.

```sql
begin;

insert into public.agents (id, name, active)
values
  ('ag_concurrency_a_20261031', 'Concurrency test A', true),
  ('ag_concurrency_b_20261031', 'Concurrency test B', true);

commit;
```

## 2. Lock-holder session

Run this and leave the transaction open. Do not press rollback.

```sql
begin;

select id, total_limit_yocto, spent_yocto, reserved_yocto
from public.agent_budgets
where id = 'default'
for update;

update public.agent_budgets
set total_limit_yocto = spent_yocto + reserved_yocto + 100
where id = 'default';

-- Keep this transaction open while starting Caller A and Caller B.
```

This deliberately holds the shared budget row lock. Both callers should block while trying to reserve.

## 3. Caller A session

Start this while the Lock-holder transaction is still open:

```sql
select public.reserve_agent_spend(
  'ag-concurrency-a-20261031',
  75,
  'concurrency-a.testnet',
  'ag_concurrency_a_20261031'
);
```

## 4. Caller B session

Start this independently, also while the Lock-holder transaction is still open:

```sql
select public.reserve_agent_spend(
  'ag-concurrency-b-20261031',
  75,
  'concurrency-b.testnet',
  'ag_concurrency_b_20261031'
);
```

Both calls should wait on the same budget row lock. Now return to the Lock-holder session and commit:

```sql
commit;
```

## 5. Expected result

After the lock-holder commits, the two waiting calls proceed serially. Exactly one should return `created: true` and `status: reserved`. The other should return `created: false` and `status: blocked`.

The budget's reserved amount should increase by exactly 75, not 150. The order of the winner is nondeterministic.

If both return created, stop: do not use the transfer endpoint. Capture the SQL results and investigate the database function and schema.

## 6. Cleanup

After recording the results, run this in a fresh session. Replace the original limit with the exact value recorded before the test.

```sql
begin;

-- Release whichever test reservation was created. Calling failed on the
-- blocked request is harmless only if no reservation exists; therefore
-- inspect first and call finish only for the row whose status is reserved.
select request_id, amount_yocto, status, agent_id
from public.spend_reservations
where request_id in (
  'ag-concurrency-a-20261031',
  'ag-concurrency-b-20261031'
);

-- If Caller A won, execute this line:
-- select public.finish_agent_spend('ag-concurrency-a-20261031', 'failed', null, 'concurrency test cleanup');

-- If Caller B won, execute this line:
-- select public.finish_agent_spend('ag-concurrency-b-20261031', 'failed', null, 'concurrency test cleanup');

-- Restore the exact total_limit_yocto value recorded before the test.
-- Replace <ORIGINAL_TOTAL_LIMIT_YOCTO> with that integer:
-- update public.agent_budgets
-- set total_limit_yocto = <ORIGINAL_TOTAL_LIMIT_YOCTO>
-- where id = 'default';

-- Delete only the test reservation rows after confirming they are failed/blocked.
-- Delete the test agents after their reservations have been removed.
commit;
```

Do not delete or modify any non-test reservation. Do not proceed if the original limit cannot be restored confidently.
