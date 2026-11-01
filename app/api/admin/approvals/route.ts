import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAdmin } from "@/lib/agent-auth";
import { getSupabase } from "@/lib/supabase";
import { getOutLayerConfig, transferNear } from "@/lib/outlayer";
import { consumeRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), requestId: z.string().min(8).max(128) }),
  z.object({ action: z.literal("reject"), requestId: z.string().min(8).max(128), reason: z.string().trim().min(3).max(500) })
]);

export async function POST(request: NextRequest) {
  let identity: ReturnType<typeof authenticateAdmin>;
  try {
    identity = authenticateAdmin(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity?.isAdmin) return NextResponse.json({ error: "admin_required" }, { status: 403 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const limit = await consumeRateLimit(`admin:${identity.agentId}`, "transfer_approval", 20, 60);
  if (!limit) return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  if (!limit.allowed) {
    return NextResponse.json({ error: "rate_limit_exceeded", retryAfterSeconds: limit.retryAfterSeconds }, {
      status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) }
    });
  }

  const db = getSupabase();
  if (parsed.data.action === "reject") {
    const { data, error } = await db.rpc("reject_agent_transfer", {
      p_request_id: parsed.data.requestId,
      p_actor_agent_id: identity.agentId,
      p_reason: parsed.data.reason
    });
    if (error) return NextResponse.json({ error: "transfer_rejection_failed", reason: error.message }, { status: 409 });
    return NextResponse.json({ status: "rejected", result: data });
  }

  // Validate the current provider/network configuration and global transfer
  // cap before consuming the one-time approval.
  try {
    getOutLayerConfig();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "outlayer_configuration_invalid";
    return NextResponse.json({ error: reason }, { status: 503 });
  }

  const { data: pending, error: pendingError } = await db.from("spend_reservations")
    .select("amount_yocto::text,status")
    .eq("request_id", parsed.data.requestId)
    .maybeSingle();
  if (pendingError || !pending) return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });
  if (pending.status !== "awaiting_approval") return NextResponse.json({ error: "approval_not_pending" }, { status: 409 });
  const globalCap = BigInt(process.env.AGENTGUARD_MAX_TRANSFER_YOCTO ?? "0");
  const pendingAmount = BigInt(pending.amount_yocto);
  if (globalCap <= 0n || pendingAmount > globalCap) {
    return NextResponse.json({ error: "global_per_transaction_limit" }, { status: 403 });
  }

  const { data: approved, error: approvalError } = await db.rpc("approve_agent_transfer", {
    p_request_id: parsed.data.requestId,
    p_actor_agent_id: identity.agentId
  });
  if (approvalError) return NextResponse.json({ error: "transfer_approval_failed", reason: approvalError.message }, { status: 409 });

  const requestId = String(approved.request_id);
  const recipient = String(approved.recipient);
  const amountYocto = String(approved.amount_yocto);

  let txHash: string | null = null;
  let providerRequestId: string | null = null;
  let reason = "outlayer_response_unknown";

  try {
    const result = await transferNear(recipient, amountYocto);
    txHash = typeof result.body.tx_hash === "string" ? result.body.tx_hash : null;
    providerRequestId = typeof result.body.request_id === "string"
      ? result.body.request_id
      : typeof result.body.requestId === "string" ? result.body.requestId : null;

    if (result.httpStatus >= 200 && result.httpStatus < 300 && txHash) {
      reason = "awaiting_onchain_confirmation";
    } else if (result.httpStatus === 422 && result.body.error === "onchain_tx_failed" && txHash) {
      reason = "awaiting_onchain_confirmation_after_provider_revert";
    } else if (result.httpStatus >= 200 && result.httpStatus < 300 && providerRequestId) {
      reason = "unverified_native_transfer_response";
    } else {
      reason = `unclassified_outlayer_response_${result.httpStatus}`;
    }
  } catch {
    // Approval has already been consumed. Preserve the reservation for manual
    // investigation; never retry an ambiguous provider submission automatically.
    reason = "outlayer_timeout_or_connection_error";
  }

  let ledgerError: { message: string } | null = null;
  if (txHash || providerRequestId) {
    const { error } = await db.rpc("record_outlayer_submission", {
      p_request_id: requestId,
      p_tx_hash: txHash,
      p_provider_request_id: providerRequestId,
      p_error: reason
    });
    ledgerError = error;
  } else {
    const { error } = await db.rpc("finish_agent_spend", {
      p_request_id: requestId,
      p_outcome: "needs_review",
      p_tx_hash: null,
      p_error: reason
    });
    ledgerError = error;
  }

  return NextResponse.json({
    status: "needs_review",
    requestId,
    txHash,
    providerRequestId,
    reason: ledgerError ? "ledger_finalisation_failed" : reason
  }, { status: 202 });
}
