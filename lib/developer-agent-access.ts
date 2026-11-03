import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export async function requireOwnedAgent(userId: string, agentId: string) {
  const { data, error } = await getSupabase().from("agents")
    .select("id,name,active,owner_user_id")
    .eq("id", agentId)
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (error) return { response: NextResponse.json({ error: "agent_ownership_check_failed" }, { status: 503 }), agent: null };
  if (!data) return { response: NextResponse.json({ error: "agent_not_found" }, { status: 404 }), agent: null };
  return { response: null, agent: data };
}
