/** GET /api/tasks — إحصائيات + أحدث المهام للوحة التحكم (تُحدَّث كل ~5 ثوانٍ) */
import { NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [stats, tasks] = await Promise.all([taskStats(), listRecentTasks(20)]);
    return NextResponse.json({ stats, tasks });
  } catch (e) {
    return NextResponse.json({ error: `تعذر جلب المهام: ${(e as Error).message}` }, { status: 500 });
  }
}
