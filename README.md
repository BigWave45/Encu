# AgentGuard

AgentGuard is a transaction-control gateway for AI agents. It evaluates transfer requests against policy and budget controls before they reach a custody/signing provider.

## Health check

The read-only endpoint is:

`GET /api/health`

It checks that the required Supabase environment variables are present and that the application can query the `agent_budgets` table for the default budget.

Possible responses include:

- `200` with `status: "ok"` when the database check succeeds and the default budget exists.
- `503` with `status: "configuration_missing"` when required Supabase environment variables are absent.
- `503` with `status: "database_error"` and a database error code/message when the query fails.
- `503` with `status: "database_connected"` and `budget: "missing"` when the query succeeds but no default budget row exists.
- `503` with `status: "database_unavailable"` when the database client throws during the check.

The endpoint is read-only. It does not initiate transfers or expose environment-variable values.
