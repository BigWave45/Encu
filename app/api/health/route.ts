import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getOutLayerConfig } from "@/lib/outlayer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AddressResponse = {
  executor_account_id?: unknown;
  near_address?: unknown;
  address?: unknown;
  account_id?: unknown;
};

async function checkOutLayer(): Promise<{
  status: "not_configured" | "connected" | "authentication_failed" | "unavailable" | "signer_mismatch" | "configuration_invalid";
  signerMatches?: boolean;
}> {
  let config;
  try {
    config = getOutLayerConfig();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    return {
      status: reason === "outlayer_configuration_missing" ? "not_configured" : "configuration_invalid"
    };
  }

  try {
    const response = await fetch(`${config.baseUrl}/wallet/v1/address?chain=near`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000)
    });
    if (response.status === 401 || response.status === 403) return { status: "authentication_failed" };
    if (!response.ok) return { status: "unavailable" };

    const body = await response.json().catch(() => null) as AddressResponse | null;
    const actualAddress = body && (
      typeof body.near_address === "string" ? body.near_address :
      typeof body.address === "string" ? body.address :
      typeof body.account_id === "string" ? body.account_id : null
    );
    if (!actualAddress) return { status: "unavailable" };
    if (actualAddress !== config.nearAddress) {
      return { status: "signer_mismatch", signerMatches: false };
    }
    return { status: "connected", signerMatches: true };
  } catch {
    return { status: "unavailable" };
  }
}

export async function GET() {
  const missing = [
    !process.env.SUPABASE_URL && "SUPABASE_URL",
    !process.env.SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY"
  ].filter(Boolean);

  if (missing.length > 0) {
    return NextResponse.json({ status: "configuration_missing", missing }, { status: 503 });
  }

  try {
    const db = getSupabase();
    const { data, error } = await db
      .from("agent_budgets")
      .select("id")
      .eq("id", "default")
      .maybeSingle();

    if (error) {
      return NextResponse.json({
        status: "database_error",
        code: error.code ?? null,
        message: error.message ?? "Supabase query failed."
      }, { status: 503 });
    }
    if (!data) return NextResponse.json({ status: "database_connected", budget: "missing" }, { status: 503 });

    const outlayer = await checkOutLayer();
    const ready = outlayer.status === "connected";
    return NextResponse.json({
      status: ready ? "ok" : "not_ready",
      supabase: "connected",
      budget: "configured",
      outlayer: outlayer.status,
      signerMatches: outlayer.signerMatches ?? false
    }, { status: ready ? 200 : 503 });
  } catch {
    return NextResponse.json({
      status: "database_unavailable",
      message: "Could not connect to Supabase."
    }, { status: 503 });
  }
}
