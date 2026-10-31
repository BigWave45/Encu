import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    return NextResponse.json({
      status: "ok",
      supabase: "connected",
      budget: "configured",
      outlayer: process.env.OUTLAYER_API_KEY ? "configured" : "not_configured",
    });
  } catch {
    return NextResponse.json(
      { status: "database_unavailable", message: "Could not connect to Supabase." },
      { status: 503 }
    );
  }
}
