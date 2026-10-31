import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agent-auth";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let identity: Awaited<ReturnType<typeof authenticateAgent>>;
  try {
    identity = await authenticateAgent(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity?.isAdmin) {
    return NextResponse.json({ error: "admin_required" }, { status: 403 });
  }

  try {
    const db = getSupabase();
    const [budgetResult, agentsResult, reservationsResult, auditResult] = await Promise.all([
      db.from("agent_budgets")
        .select("id,total_limit_yocto::text,spent_yocto::text,reserved_yocto::text,updated_at")
        .eq("id", "default")
        .maybeSingle(),
      db.from("agents")
        .select("id,name,active,created_at")
        .order("created_at", { ascending: true }),
      db.from("spend_reservations")
        .select("request_id,agent_id,recipient,amount_yocto::text,status,outlayer_tx_hash,outlayer_request_id,last_error,created_at,updated_at")
        .order("created_at", { ascending: false })
        .limit(100),
      db.from("agentguard_admin_audit")
        .select("id,actor_agent_id,action,target_id,details,created_at")
        .order("created_at", { ascending: false })
        .limit(30)
    ]);

    if (budgetResult.error || agentsResult.error || reservationsResult.error || auditResult.error) {
      return NextResponse.json({ error: "dashboard_query_failed" }, { status: 500 });
    }
    if (!budgetResult.data) {
      return NextResponse.json({ error: "budget_not_configured" }, { status: 503 });
    }

    const asString = (value: unknown) => value == null ? "0" : String(value);
    return NextResponse.json({
      status: "ok",
      generatedAt: new Date().toISOString(),
      budget: {
        id: budgetResult.data.id,
        totalLimitYocto: asString(budgetResult.data.total_limit_yocto),
        spentYocto: asString(budgetResult.data.spent_yocto),
        reservedYocto: asString(budgetResult.data.reserved_yocto),
        updatedAt: budgetResult.data.updated_at
      },
      agents: (agentsResult.data ?? []).map((agent) => ({
        id: agent.id,
        name: agent.name,
        active: agent.active,
        createdAt: agent.created_at
      })),
      reservations: (reservationsResult.data ?? []).map((item) => ({
        requestId: item.request_id,
        agentId: item.agent_id,
        recipient: item.recipient,
        amountYocto: asString(item.amount_yocto),
        status: item.status,
        txHash: item.outlayer_tx_hash,
        providerRequestId: item.outlayer_request_id,
        lastError: item.last_error,
        createdAt: item.created_at,
        updatedAt: item.updated_at
      })),
      audit: (auditResult.data ?? []).map((item) => ({
        id: item.id,
        actorAgentId: item.actor_agent_id,
        action: item.action,
        targetId: item.target_id,
        details: item.details,
        createdAt: item.created_at
      }))
    }, {
      headers: { "Cache-Control": "no-store, private" }
    });
  } catch {
    return NextResponse.json({ error: "dashboard_unavailable" }, { status: 503 });
  }
}
