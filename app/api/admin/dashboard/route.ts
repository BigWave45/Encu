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
    const url = new URL(request.url);
    const requestedPage = Number(url.searchParams.get("page") ?? "1");
    const requestedPageSize = Number(url.searchParams.get("pageSize") ?? "20");
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const pageSize = Number.isSafeInteger(requestedPageSize) ? Math.min(50, Math.max(1, requestedPageSize)) : 20;
    const status = url.searchParams.get("status") ?? "all";
    const allowedStatuses = ["all", "reserved", "needs_review", "executed", "failed"];
    if (!allowedStatuses.includes(status)) {
      return NextResponse.json({ error: "invalid_status_filter" }, { status: 400 });
    }
    const search = (url.searchParams.get("q") ?? "").trim().slice(0, 128);
    let reservationsQuery = db.from("spend_reservations")
      .select("request_id,agent_id,recipient,amount_yocto::text,status,outlayer_tx_hash,outlayer_request_id,last_error,created_at,updated_at", { count: "exact" })
      .order("created_at", { ascending: false });
    if (status !== "all") reservationsQuery = reservationsQuery.eq("status", status);
    if (search) reservationsQuery = reservationsQuery.ilike("request_id", `%${search}%`);
    reservationsQuery = reservationsQuery.range((page - 1) * pageSize, page * pageSize - 1);
    const [budgetResult, agentsResult, reservationsResult, auditResult, securityResult] = await Promise.all([
      db.from("agent_budgets")
        .select("id,total_limit_yocto::text,spent_yocto::text,reserved_yocto::text,updated_at")
        .eq("id", "default")
        .maybeSingle(),
      db.from("agents")
        .select("id,name,active,created_at")
        .order("created_at", { ascending: true }),
      reservationsQuery,
      db.from("agentguard_admin_audit")
        .select("id,actor_agent_id,action,target_id,details,created_at")
        .order("created_at", { ascending: false })
        .limit(30),
      db.from("agentguard_security_events")
        .select("id,actor_agent_id,event_type,request_id,details,created_at")
        .order("created_at", { ascending: false })
        .limit(50)
    ]);

    if (budgetResult.error || agentsResult.error || reservationsResult.error || auditResult.error || securityResult.error) {
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
      reservationPage: {
        page,
        pageSize,
        total: reservationsResult.count ?? 0,
        totalPages: Math.max(1, Math.ceil((reservationsResult.count ?? 0) / pageSize)),
        status,
        search
      },
      securityEvents: (securityResult.data ?? []).map((item) => ({
        id: item.id,
        actorAgentId: item.actor_agent_id,
        eventType: item.event_type,
        requestId: item.request_id,
        details: item.details,
        createdAt: item.created_at
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
