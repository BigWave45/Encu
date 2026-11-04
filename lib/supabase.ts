import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
// Prefer a deployment-specific secret when configured. Keep the legacy key
// supported for existing Production deployments.
const serviceRoleKey = process.env.AGENTGUARD_SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY;

export function getSupabase() {
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase server credentials are not configured.");
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}