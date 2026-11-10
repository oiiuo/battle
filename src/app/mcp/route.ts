/**
 * خادم MCP على المسار /mcp — نقل Streamable HTTP حسب مواصفات MCP.
 * نستخدم SDK الرسمي: McpServer + WebStandardStreamableHTTPServerTransport
 * (يعمل مباشرة مع Web Request/Response في Next.js App Router بلا أي شيم).
 *
 * - POST: رسائل JSON-RPC | GET: قناة استماع SSE | DELETE: إنهاء الجلسة
 * - إذا ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token>
 * - الجلسات تُحفظ في الذاكرة وفق mcp-session-id
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomUUID } from "node:crypto";
import { SERVER_INFO, SERVER_INSTRUCTIONS } from "@/lib/serverInfo";
import { registerTools } from "@/lib/mcpTools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface SessionEntry {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

const sessions = new Map<string, SessionEntry>();

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, mcp-session-id",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function authOk(request: Request): boolean {
  const expected = (process.env.MCP_ACCESS_TOKEN || "").trim();
  if (!expected) return true;
  const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return got === expected;
}

function createSession(): SessionEntry {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server);
  const entry: SessionEntry = { server, transport: undefined as unknown as WebStandardStreamableHTTPServerTransport };
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, entry);
    },
  });
  entry.transport = transport;
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && sessions.get(sid) === entry) sessions.delete(sid);
  };
  void server.connect(transport);
  return entry;
}

async function handle(request: Request): Promise<Response> {
  if (!authOk(request)) {
    return new Response(JSON.stringify({ error: "unauthorized — MCP_ACCESS_TOKEN مطلوب (Bearer)" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  try {
    const sid = request.headers.get("mcp-session-id");
    let entry = sid ? sessions.get(sid) : undefined;
    if (!entry) {
      // أول رسالة للعميل (initialize) → أنشئ جلسة جديدة
      // إن لم تكن initialize سيغلق النقل الاتصال بخطأ مناسب ويزيل نفسه عبر onclose
      entry = createSession();
    }
    const response = await entry.transport.handleRequest(request);
    // تنظيف الجلسات التي لم تُهيأ فعليًا (طلب تالف)
    if (!entry.transport.sessionId) {
      try { await entry.transport.close(); } catch { /* غير مهم */ }
    }
    return withCors(response);
  } catch (e) {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}

export async function DELETE(request: Request) {
  return handle(request);
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
