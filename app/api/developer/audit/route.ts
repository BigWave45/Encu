import { NextRequest, NextResponse } from "next/server";
import { authenticateDeveloper } from "@/lib/developer-auth";
import { getSupabase } from "@/lib/supabase";
import { consumeRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let identity;
  try {
    identity = await authenticateDeveloper(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity) return NextResponse.json({ error: "developer_authentication_required" }, { status: 401 });

  const rate = await consumeRateLimit(`developer:${identity.userId}`, "developer_audit_read", 60, 60);
  if (!rate) return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  if (!rate.allowed) return NextResponse.json(
    { error: "rate_limit_exceeded", retryAfterSeconds: rate.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
  );

  const db = getSupabase();
  const { data: agents, error: agentsError } = await db.from("agents")
    .select("id").eq("owner_user_id", identity.userId);
  if (agentsError) return NextResponse.json({ error: "developer_audit_read_failed" }, { status: 503 });
  const agentIds = (agents ?? []).map(row => row.id);
  const auditQuery = db.from("agentguard_admin_audit")
    .select("id,actor_agent_id,action,target_id,details,created_at")
    .order("created_at", { ascending: false }).limit(100);
  const auditRequest = agentIds.length
    ? auditQuery.or(`actor_agent_id.eq.developer:${identity.userId},target_id.in.(${agentIds.join(",")})`)
    : auditQuery.eq("actor_agent_id", `developer:${identity.userId}`);
  const securityRequest = agentIds.length
    ? db.from("agentguard_security_events")
        .select("id,actor_agent_id,event_type,request_id,details,created_at")
        .in("actor_agent_id", agentIds).order("created_at", { ascending: false }).limit(100)
    : Promise.resolve({ data: [], error: null });

  const [audit, security] = await Promise.all([auditRequest, securityRequest]);
  if (audit.error || security.error) return NextResponse.json({ error: "developer_audit_read_failed" }, { status: 503 });

  const events = [
    ...(audit.data ?? []).map(row => ({
      id: `audit:${row.id}`, source: "audit", actor: row.actor_agent_id,
      action: row.action, targetId: row.target_id, requestId: null,
      details: row.details, createdAt: row.created_at
    })),
    ...(security.data ?? []).map(row => ({
      id: `security:${row.id}`, source: "security", actor: row.actor_agent_id,
      action: row.event_type, targetId: row.actor_agent_id, requestId: row.request_id,
      details: row.details, createdAt: row.created_at
    }))
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 100);

  return NextResponse.json({ events }, { headers: { "Cache-Control": "no-store, private" } });
}
