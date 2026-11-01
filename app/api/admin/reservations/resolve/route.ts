import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAdmin } from "@/lib/agent-auth";
import { adminRateLimitResponse } from "@/lib/admin-rate-limit";
import { getSupabase } from "@/lib/supabase";
import { getNearRpcUrl, getOutLayerConfig } from "@/lib/outlayer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("cancel_expired"),
    requestId: z.string().min(8).max(128),
    reason: z.string().trim().min(3).max(500)
  }),
  z.object({
    action: z.literal("failed_final"),
    requestId: z.string().min(8).max(128),
    reason: z.string().trim().min(3).max(500),
    evidenceReference: z.string().trim().min(8).max(500)
  })
]);

type NearTxResult = {
  final_execution_status?: string;
  status?: { SuccessValue?: string; Failure?: unknown; SuccessReceiptId?: string };
  transaction?: {
    signer_id?: string;
    receiver_id?: string;
    actions?: Array<{ Transfer?: { deposit?: string } }>;
  };
};

export async function POST(request: NextRequest) {
  let identity: ReturnType<typeof authenticateAdmin>;
  try {
    identity = authenticateAdmin(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity?.isAdmin) return NextResponse.json({ error: "admin_required" }, { status: 403 });

  const limited = await adminRateLimitResponse(identity.agentId, "reservation_resolution", 10, 60);
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const db = getSupabase();
  if (parsed.data.action === "cancel_expired") {
    const { data, error } = await db.rpc("cancel_expired_agent_transfer", {
      p_request_id: parsed.data.requestId,
      p_actor_agent_id: identity.agentId,
      p_reason: parsed.data.reason
    });
    if (error) {
      const status = error.message.includes("reservation_not_found") ? 404 : 409;
      return NextResponse.json({ error: "expired_transfer_cancellation_failed", reason: error.message }, { status });
    }
    return NextResponse.json({ status: "cancelled", result: data });
  }

  const { data: reservation, error: lookupError } = await db.from("spend_reservations")
    .select("request_id,status,outlayer_tx_hash,recipient,amount_yocto::text,agent_id")
    .eq("request_id", parsed.data.requestId)
    .maybeSingle();
  if (lookupError) return NextResponse.json({ error: "reservation_lookup_failed" }, { status: 503 });
  if (!reservation) return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });
  if (!["reserved", "needs_review"].includes(reservation.status) || !reservation.outlayer_tx_hash) {
    return NextResponse.json({ error: "reservation_not_resolvable", reason: "matching_transaction_hash_required" }, { status: 409 });
  }

  let signerId: string;
  let rpcUrl: string;
  try {
    signerId = getOutLayerConfig().nearAddress;
    rpcUrl = getNearRpcUrl();
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "near_configuration_invalid"
    }, { status: 503 });
  }

  let result: NearTxResult;
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "agentguard-admin-resolution",
        method: "tx",
        params: {
          tx_hash: reservation.outlayer_tx_hash,
          sender_account_id: signerId,
          wait_until: "FINAL"
        }
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(20000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error || !body.result) {
      return NextResponse.json({ error: "near_final_transaction_not_verified" }, { status: 202 });
    }
    result = body.result as NearTxResult;
  } catch {
    return NextResponse.json({ error: "near_final_transaction_lookup_unavailable" }, { status: 202 });
  }

  const matchesReservedTransfer =
    result.final_execution_status === "FINAL" &&
    result.transaction?.signer_id === signerId &&
    result.transaction?.receiver_id === reservation.recipient &&
    Array.isArray(result.transaction?.actions) &&
    result.transaction.actions.length === 1 &&
    result.transaction.actions[0].Transfer?.deposit === String(reservation.amount_yocto);

  if (!matchesReservedTransfer) {
    return NextResponse.json({ error: "final_transaction_does_not_match_reserved_transfer" }, { status: 409 });
  }
  if (!result.status || !Object.prototype.hasOwnProperty.call(result.status, "Failure")) {
    return NextResponse.json({
      error: "transaction_is_not_a_final_failure",
      reason: Object.prototype.hasOwnProperty.call(result.status ?? {}, "SuccessValue")
        ? "transaction_succeeded_use_reconciliation"
        : "final_outcome_unrecognised"
    }, { status: 409 });
  }

  const { data, error } = await db.rpc("resolve_agent_transfer_failed_final", {
    p_request_id: parsed.data.requestId,
    p_actor_agent_id: identity.agentId,
    p_reason: parsed.data.reason,
    p_evidence_reference: parsed.data.evidenceReference
  });
  if (error) {
    const status = error.message.includes("reservation_not_found") ? 404 : 409;
    return NextResponse.json({ error: "failed_final_resolution_failed", reason: error.message }, { status });
  }
  return NextResponse.json({ status: "failed", result: data });
}
