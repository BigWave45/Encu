import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import { getOutLayerConfig, transferNear } from "@/lib/outlayer";
import { authenticateAgent } from "@/lib/agent-auth";
import { recordSecurityEvent } from "@/lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  requestId: z.string().min(8).max(128),
  to: z.string().min(2).max(64).regex(/^[a-z0-9]+([._-][a-z0-9]+)*$/),
  amountYocto: z.string().max(78).regex(/^[1-9][0-9]*$/)
});

export async function POST(request: NextRequest) {
  let identity: Awaited<ReturnType<typeof authenticateAgent>>;
  try {
    identity = await authenticateAgent(request.headers.get("authorization"));
  } catch {
    await recordSecurityEvent({ eventType: "transfer_authentication_unavailable" });
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity) {
    await recordSecurityEvent({ eventType: "transfer_unauthorized" });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    await recordSecurityEvent({ actorAgentId: identity.agentId, eventType: "transfer_invalid_request" });
    return NextResponse.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });
  }

  // Fail closed before reserving budget if the configured provider is not the
  // official OutLayer testnet endpoint or the expected signer is not configured.
  try {
    getOutLayerConfig();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "outlayer_configuration_invalid";
    await recordSecurityEvent({ actorAgentId: identity.agentId, eventType: "transfer_provider_configuration_blocked" });
    return NextResponse.json({ error: reason }, { status: 503 });
  }

  const { requestId, to, amountYocto } = parsed.data;
  const amount = BigInt(amountYocto);
  const cap = BigInt(process.env.AGENTGUARD_MAX_TRANSFER_YOCTO ?? "0");
  if (cap <= 0n || amount > cap) {
    await recordSecurityEvent({ actorAgentId: identity.agentId, eventType: "transfer_per_transaction_limit_blocked", requestId });
    return NextResponse.json({ status: "blocked", reason: "per_transaction_limit" }, { status: 403 });
  }

  const db = getSupabase();
  const { data: reservation, error } = await db.rpc("reserve_agent_spend", {
    p_request_id: requestId,
    p_amount_yocto: amountYocto,
    p_recipient: to,
    p_agent_id: identity.agentId
  });
  if (error) {
    const conflict = error.message.includes("idempotency_key_conflict");
    await recordSecurityEvent({ actorAgentId: identity.agentId, eventType: conflict ? "transfer_idempotency_conflict" : "transfer_reservation_error", requestId });
    return NextResponse.json(
      { error: conflict ? "idempotency_key_conflict" : "reservation_failed" },
      { status: conflict ? 409 : 500 }
    );
  }
  if (reservation?.status === "blocked") {
    await recordSecurityEvent({ actorAgentId: identity.agentId, eventType: "transfer_shared_budget_blocked", requestId });
    return NextResponse.json(reservation, { status: 403 });
  }

  // Only the insert winner can contact OutLayer. Replays never submit twice.
  if (reservation?.created !== true) {
    await recordSecurityEvent({ actorAgentId: identity.agentId, eventType: "transfer_replay_rejected", requestId });
    return NextResponse.json({ status: reservation?.status ?? "already_processed", requestId }, { status: 409 });
  }

  let txHash: string | null = null;
  let providerRequestId: string | null = null;
  let reason = "outlayer_response_unknown";

  try {
    const result = await transferNear(to, amountYocto);
    txHash = typeof result.body.tx_hash === "string" ? result.body.tx_hash : null;
    providerRequestId = typeof result.body.request_id === "string"
      ? result.body.request_id
      : typeof result.body.requestId === "string"
        ? result.body.requestId
        : null;

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
    // A timeout is ambiguous: keep the reservation held and never auto-retry.
    reason = "outlayer_timeout_or_connection_error";
  }

  let finishError: { message: string } | null = null;
  if (txHash || providerRequestId) {
    // One atomic DB operation stores provider references and marks the
    // reservation needs_review. No split update can lose one reference.
    const { error } = await db.rpc("record_outlayer_submission", {
      p_request_id: requestId,
      p_tx_hash: txHash,
      p_provider_request_id: providerRequestId,
      p_error: reason
    });
    finishError = error;
  } else {
    const { error } = await db.rpc("finish_agent_spend", {
      p_request_id: requestId,
      p_outcome: "needs_review",
      p_tx_hash: null,
      p_error: reason
    });
    finishError = error;
  }

  if (finishError) {
    return NextResponse.json({
      status: "needs_review",
      requestId,
      txHash,
      providerRequestId,
      reason: "ledger_finalisation_failed"
    }, { status: 202 });
  }

  return NextResponse.json({
    status: "needs_review",
    requestId,
    txHash,
    providerRequestId,
    reason
  }, { status: 202 });
}
