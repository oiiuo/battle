/**
 * GET /api/health — حالة النظام للواجهة والعملاء.
 * merger.healthy = فحص GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ.
 */
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { getModels } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function checkMerger(): Promise<{ base: string | null; healthy: boolean }> {
  const base = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");
  if (!base || base.includes("xxxxxxxx")) return { base: null, healthy: false };
  try {
    const res = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(4000) });
    return { base, healthy: res.ok };
  } catch {
    return { base, healthy: false };
  }
}

export async function GET() {
  const ok = await dbHealthy();
  const merger = await checkMerger();
  return NextResponse.json(
    {
      ok,
      database: ok ? "turso-connected" : "disconnected",
      mcpEndpoint: "/mcp",
      models: getModels().map(({ canonical, type, providers }) => ({ canonical, type, providers })),
      merger,
      authRequired: !!(process.env.MCP_ACCESS_TOKEN || "").trim(),
    },
    { status: ok ? 200 : 503 }
  );
}
