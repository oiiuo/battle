/**
 * سجل الموديلات — الاسم القانوني كما يراه عميل MCP + الصيغ البديلة المقبولة
 * + المزودون الذين يخدمونه + اسم الموديل كما يُرسل لكل مزود.
 * الأسماء قابلة للتجاوز بمتغيرات البيئة (KIE_IMAGE_MODEL ...).
 */

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

const envVal = (v: string | undefined) => (v && v.trim()) || undefined;

function build(): ModelDef[] {
  const kieImage = envVal(process.env.KIE_IMAGE_MODEL) ?? "gpt-image-2-6/flare-text-to-image";
  const kieVideo = envVal(process.env.KIE_VIDEO_MODEL) ?? "grok-imagine-video-1-5-preview";
  const cometImage = envVal(process.env.COMETAPI_IMAGE_MODEL) ?? "gpt-image-2.6-flare-text-to-image";
  const cometVideo = envVal(process.env.COMETAPI_VIDEO_MODEL) ?? "grok-imagine-video-1-5-preview";

  return [
    {
      canonical: "gpt-image-2-6/flare-text-to-image",
      aliases: ["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"],
      type: "image",
      providers: ["kie", "cometapi"],
      providerModel: { kie: kieImage, cometapi: cometImage },
    },
    {
      canonical: "grok-imagine-video-1-5-preview",
      aliases: ["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"],
      type: "video",
      providers: ["kie", "cometapi"],
      providerModel: { kie: kieVideo, cometapi: cometVideo },
    },
  ];
}

let _models: ModelDef[] | null = null;
export function getModels(): ModelDef[] {
  if (!_models) _models = build();
  return _models;
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/\./g, "-").replace(/_+/g, "-");

/** توحيد اسم الموديل عبر aliases — يقبل الصيغ بالنقاط ويعيد التعريف القانوني */
export function normalizeModel(name?: string | null): ModelDef | undefined {
  if (!name || !name.trim()) return undefined;
  const n = normalize(name);
  return getModels().find(
    (m) => normalize(m.canonical) === n || m.aliases.some((a) => normalize(a) === n)
  );
}
