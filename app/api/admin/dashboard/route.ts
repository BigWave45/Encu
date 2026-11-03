import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/agent-auth";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let identity: ReturnType<typeof authenticateAdmin>;
  try {
    identity = authenticateAdmin(request.headers.get("authorization"));
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
    const allowedStatuses = ["all", "awaiting_approval", "reserved", "needs_review", "executed", "failed", "rejected", "cancelled", "aged"];
    if (!allowedStatuses.includes(status)) {
      return NextResponse.json({ error: "invalid_status_filter" }, { status: 400 });
    }
    const search = (url.searchParams.get("q") ?? "").trim().slice(0, 128);
    if (search && !/^[a-zA-Z0-9._:-]{2,128}$/.test(search)) {
      return NextResponse.json({ error: "invalid_search_query" }, { status: 400 });
    }
    const auditPageInput = Number(url.searchParams.get("auditPage") ?? "1");
    const securityPageInput = Number(url.searchParams.get("securityPage") ?? "1");
    const auditPage = Number.isSafeInteger(auditPageInput) && auditPageInput > 0 ? auditPageInput : 1;
    const securityPage = Number.isSafeInteger(securityPageInput) && securityPageInput > 0 ? securityPageInput : 1;
    const activityPageSize = 20;
    let reservationsQuery = db.from("spend_reservations")
      .select("request_id,agent_id,recipient,amount_yocto::text,status,outlayer_tx_hash,outlayer_request_id,last_error,created_at,updated_at,approval_expires_at,approved_at,approved_by,rejected_at,rejected_by,approval_reason,cancelled_at,cancelled_by,resolved_at,resolved_by,resolution_reason,resolution_evidence_reference", { count: "exact" })
      .order("created_at", { ascending: false });
    if (status === "aged") {
      const agedBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      reservationsQuery = reservationsQuery
        .or("status.eq.needs_review,and(status.eq.reserved,outlayer_tx_hash.is.null,outlayer_request_id.is.null)")
        .lte("created_at", agedBefore);
    } else if (status !== "all") {
      reservationsQuery = reservationsQuery.eq("status", status);
    }
    if (search) reservationsQuery = reservationsQuery.or(
      `request_id.ilike.%${search}%,agent_id.ilike.%${search}%,recipient.ilike.%${search}%,outlayer_tx_hash.ilike.%${search}%,outlayer_request_id.ilike.%${search}%`
    );
    reservationsQuery = reservationsQuery.range((page - 1) * pageSize, page * pageSize - 1);
    const [budgetResult, agentsResult, reservationsResult, auditResult, securityResult, controlsResult, policiesResult, allocationsResult] = await Promise.all([
      db.from("agent_budgets")
        .select("id,total_limit_yocto::text,spent_yocto::text,reserved_yocto::text,updated_at")
        .eq("id", "default")
        .maybeSingle(),
      db.from("agents")
        .select("id,name,active,created_at")
        .order("created_at", { ascending: true }),
      reservationsQuery,
      db.from("agentguard_admin_audit")
        .select("id,actor_agent_id,action,target_id,details,created_at", { count: "exact" })
        .order("created_at", { ascending: false })
        .range((auditPage - 1) * activityPageSize, auditPage * activityPageSize - 1),
      db.from("agentguard_security_events")
        .select("id,actor_agent_id,event_type,request_id,details,created_at", { count: "exact" })
        .order("created_at", { ascending: false })
        .range((securityPage - 1) * activityPageSize, securityPage * activityPageSize - 1),
      db.from("agentguard_system_controls")
        .select("transfers_enabled,updated_at,updated_by")
        .eq("id", "default")
        .maybeSingle(),
      db.from("agent_policies")
        .select("agent_id,max_transfer_yocto::text,daily_limit_yocto::text,weekly_limit_yocto::text,allowed_recipients,updated_at,updated_by")
        .order("agent_id", { ascending: true }),
      db.from("agent_allocations")
        .select("agent_id,allocation_limit_yocto::text,spent_yocto::text,reserved_yocto::text,updated_at,updated_by")
        .order("agent_id", { ascending: true })
    ]);

    if (budgetResult.error || agentsResult.error || reservationsResult.error || auditResult.error || securityResult.error || controlsResult.error || policiesResult.error || allocationsResult.error || !controlsResult.data) {
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
      transfersEnabled: controlsResult.data.transfers_enabled,
      transferControlsUpdatedAt: controlsResult.data.updated_at,
      transferControlsUpdatedBy: controlsResult.data.updated_by,
      policies: (policiesResult.data ?? []).map((policy) => ({
        agentId: policy.agent_id,
        maxTransferYocto: policy.max_transfer_yocto,
        dailyLimitYocto: policy.daily_limit_yocto,
        weeklyLimitYocto: policy.weekly_limit_yocto,
        allowedRecipients: policy.allowed_recipients,
        updatedAt: policy.updated_at,
        updatedBy: policy.updated_by
      })),
      allocations: (allocationsResult.data ?? []).map((allocation) => ({
        agentId: allocation.agent_id,
        allocationLimitYocto: asString(allocation.allocation_limit_yocto),
        spentYocto: asString(allocation.spent_yocto),
        reservedYocto: asString(allocation.reserved_yocto),
        updatedAt: allocation.updated_at,
        updatedBy: allocation.updated_by
      })),
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
        updatedAt: item.updated_at,
        approvalExpiresAt: item.approval_expires_at,
        approvedAt: item.approved_at,
        approvedBy: item.approved_by,
        rejectedAt: item.rejected_at,
        rejectedBy: item.rejected_by,
        approvalReason: item.approval_reason,
        cancelledAt: item.cancelled_at,
        cancelledBy: item.cancelled_by,
        resolvedAt: item.resolved_at,
        resolvedBy: item.resolved_by,
        resolutionReason: item.resolution_reason,
        resolutionEvidenceReference: item.resolution_evidence_reference
      })),
      reservationPage: {
        page,
        pageSize,
        total: reservationsResult.count ?? 0,
        totalPages: Math.max(1, Math.ceil((reservationsResult.count ?? 0) / pageSize)),
        status,
        search
      },
      activityPages: {
        pageSize: activityPageSize,
        audit: { page: auditPage, total: auditResult.count ?? 0, totalPages: Math.max(1, Math.ceil((auditResult.count ?? 0) / activityPageSize)) },
        security: { page: securityPage, total: securityResult.count ?? 0, totalPages: Math.max(1, Math.ceil((securityResult.count ?? 0) / activityPageSize)) }
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
