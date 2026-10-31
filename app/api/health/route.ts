import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function checkOutLayer(): Promise<"not_configured" | "connected" | "authentication_failed" | "unavailable"> {
  const baseUrl = process.env.OUTLAYER_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.OUTLAYER_API_KEY;

  if (!baseUrl || !apiKey) return "not_configured";

  try {
    const response = await fetch(`${baseUrl}/wallet/v1/address?chain=near`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });

    if (response.status === 401 || response.status === 403) {
      return "authentication_failed";
    }

    if (!response.ok) return "unavailable";

    const body: unknown = await response.json().catch(() => null);
    if (
      typeof body !== "object" ||
      body === null ||
      !("near_address" in body || "address" in body || "account_id" in body)
    ) {
      return "unavailable";
    }

    return "connected";
  } catch {
    return "unavailable";
  }
}

export async function GET() {
  const missing = [
    !process.env.SUPABASE_URL && "SUPABASE_URL",
    !process.env.SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY",
  ].filter(Boolean);

  if (missing.length > 0) {
    return NextResponse.json(
      { status: "configuration_missing", missing },
      { status: 503 }
    );
  }

  try {
    const db = getSupabase();
    const { data, error } = await db
      .from("agent_budgets")
      .select("id")
      .eq("id", "default")
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        {
          status: "database_error",
          code: error.code ?? null,
          message: error.message ?? "Supabase query failed.",
        },
        { status: 503 }
      );
    }

    if (!data) {
      return NextResponse.json(
        { status: "database_connected", budget: "missing" },
        { status: 503 }
      );
    }

    const outlayer = await checkOutLayer();

    return NextResponse.json({
      status: "ok",
      supabase: "connected",
      budget: "configured",
      outlayer,
    });
  } catch {
    return NextResponse.json(
      { status: "database_unavailable", message: "Could not connect to Supabase." },
      { status: 503 }
    );
  }
}
