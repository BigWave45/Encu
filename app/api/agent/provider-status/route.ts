import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import { getOutLayerConfig } from "@/lib/outlayer";
import { authenticateAgent } from "@/lib/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ requestId: z.string().min(8).max(128) });

type ProviderRequest = {
  status?: unknown;
  tx_hash?: unknown;
  result?: { tx_hash?: unknown } | null;
  error?: unknown;
};

export async function POST(request: NextRequest) {
  let identity: Awaited<ReturnType<typeof authenticateAgent>>;
  try {
    identity = await authenticateAgent(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const db = getSupabase();
  const { data: reservation, error: lookupError } = await db
    .from("spend_reservations")
    .select("request_id,status,outlayer_request_id,outlayer_tx_hash,agent_id")
    .eq("request_id", parsed.data.requestId)
    .maybeSingle();

  if (lookupError) return NextResponse.json({ error: "reservation_lookup_failed" }, { status: 500 });
  if (!reservation) return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });
  if (!identity.isAdmin && reservation.agent_id !== identity.agentId) {
    return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });
  }
  if (reservation.status === "executed" || reservation.status === "failed") {
    return NextResponse.json({
      status: reservation.status,
      requestId: reservation.request_id,
      txHash: reservation.outlayer_tx_hash
    });
  }
  if (!reservation.outlayer_request_id) {
    return NextResponse.json({
      status: reservation.status,
      requestId: reservation.request_id,
      reason: "provider_request_id_not_available"
    }, { status: 409 });
  }

  let config;
  try {
    config = getOutLayerConfig();
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "outlayer_configuration_invalid"
    }, { status: 503 });
  }

  let provider: ProviderRequest;
  let providerHttpStatus: number;
  try {
    const response = await fetch(
      `${config.baseUrl}/wallet/v1/requests/${encodeURIComponent(reservation.outlayer_request_id)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${config.apiKey}` },
        cache: "no-store",
        signal: AbortSignal.timeout(15000)
      }
    );
    providerHttpStatus = response.status;
    provider = await response.json().catch(() => ({}));
    if (!response.ok) {
      return NextResponse.json({
        status: reservation.status,
        requestId: reservation.request_id,
        providerHttpStatus,
        reason: "provider_status_lookup_failed"
      }, { status: 202 });
    }
  } catch {
    return NextResponse.json({
      status: reservation.status,
      requestId: reservation.request_id,
      reason: "provider_status_lookup_unavailable"
    }, { status: 202 });
  }

  const providerStatus = typeof provider.status === "string" ? provider.status : "unrecognised";
  const candidateHash = typeof provider.tx_hash === "string"
    ? provider.tx_hash
    : typeof provider.result?.tx_hash === "string"
      ? provider.result.tx_hash
      : null;

  let txHash = reservation.outlayer_tx_hash;
  if (candidateHash && txHash && candidateHash !== txHash) {
    return NextResponse.json({
      status: reservation.status,
      requestId: reservation.request_id,
      providerStatus,
      reason: "provider_transaction_hash_conflict"
    }, { status: 202 });
  }

  if (candidateHash && !txHash) {
    const { error: persistError } = await db.rpc("record_outlayer_submission", {
      p_request_id: reservation.request_id,
      p_tx_hash: candidateHash,
      p_provider_request_id: reservation.outlayer_request_id,
      p_error: "provider_transaction_hash_recovered"
    });
    if (persistError) {
      return NextResponse.json({
        status: reservation.status,
        requestId: reservation.request_id,
        providerStatus,
        reason: "transaction_hash_persistence_failed"
      }, { status: 202 });
    }
    txHash = candidateHash;
  }

  // OutLayer status is informational. Only independent NEAR FINAL verification
  // is allowed to settle or release reserved budget.
  return NextResponse.json({
    status: reservation.status,
    requestId: reservation.request_id,
    providerStatus,
    txHash,
    reconciliationRequired: Boolean(txHash),
    providerError: typeof provider.error === "string" ? provider.error : undefined
  });
}
