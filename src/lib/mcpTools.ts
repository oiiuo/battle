/**
 * تسجيل الأدوات الخمس على خادم MCP.
 * أوصاف الأدوات بالإنجليزية (يقرأها نموذج العميل) — أما نتائج الاستدعاء فتُصاغ بالعربية.
 * أثناء نافذة الانتظار تُرسل progress notifications كل ~3 ثوانٍ إذا زوّد العميل
 * الطلب بـ _meta.progressToken.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listMedia, refreshTask, runGeneration } from "./generation";
import { runMerge } from "./merger";
import type { Notify, ToolReply } from "./util";

/** مُبثّ التقدم — يقرأ progressToken من _meta ويرسل notifications/progress بأمان */
function makeNotifier(extra: unknown): Notify | undefined {
  const ex = extra as { _meta?: { progressToken?: unknown }; sendNotification?: (n: unknown) => Promise<void> } | undefined;
  const token = ex?._meta?.progressToken;
  const send = ex?.sendNotification;
  if (token === undefined || token === null || typeof send !== "function") return undefined;
  return async (progress: number, message: string) => {
    try {
      await send({
        method: "notifications/progress",
        params: { progressToken: token, progress, total: 100, message },
      });
    } catch {
      // العميل قد لا يدعم البث — نتجاهل بصمت
    }
  };
}

function reply(r: ToolReply) {
  return { content: [{ type: "text" as const, text: r.text }], isError: r.isError === true };
}

export function registerTools(server: McpServer): void {
  // 1) generate_image
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active API keys in strict order). " +
        "Returns a ready image URL if it finishes within the wait window; otherwise returns a task_id — " +
        "then call get_task with that task_id every ~10 seconds until status is completed, show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => reply(await runGeneration("image", args as Record<string, unknown>, makeNotifier(extra)))
  );

  // 2) generate_video
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio; optional image-to-video). " +
        "Video takes minutes: short wait with live progress, then a task_id is returned — " +
        "track it with get_task every ~10 seconds until completed, show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => reply(await runGeneration("video", args as Record<string, unknown>, makeNotifier(extra)))
  );

  // 3) merge_videos — دمج حتى 10 مقاطع بالترتيب المعطى
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Concatenate several clips into ONE final video in the given order. Pass 'urls' (public direct video URLs) or " +
        "'task_ids' (completed video generation tasks — their result URLs are merged in this order). " +
        "Merging is usually quick: short wait with live progress, then a merge task_id — track it with get_task. " +
        "the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2, "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
          .max(10, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z
          .array(z.string())
          .min(2, "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
          .max(10, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => reply(await runMerge(args as { urls?: string[]; task_ids?: string[]; wait_seconds?: number }, makeNotifier(extra)))
  );

  // 4) get_task
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its task_id — image/video generation AND merging (reads the database and refreshes live from the provider/service when still processing). " +
        "Poll it every ~10 seconds; when status is completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args) => reply(await refreshTask(String((args as { task_id: string }).task_id)))
  );

  // 5) list_media
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "Recall the latest stored images/videos/merges with their URLs from the database (no regeneration) — for retrieving previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => reply(await listMedia((args ?? {}) as { type?: string; status?: string; limit?: number }))
  );
}
