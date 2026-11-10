/** سجل المحوّلين — نختار المحوّل حسب المزود المخزَّن على المفتاح */
import type { ProviderAdapter, ProviderTaskInput } from "./types";
import { kieAdapter } from "./kie";
import { cometapiAdapter } from "./cometapi";

// إعادة تصدير الواجهات المشتركة لاستخدامها من طبقة التنسيق
export { ProviderError } from "../classify";
export type { ProviderAdapter, ProviderTaskInput, ProviderId } from "./types";

const adapters: Record<string, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

export function getAdapter(provider: string | null | undefined): ProviderAdapter {
  const a = provider ? adapters[provider] : undefined;
  if (!a) throw new Error(`مزود غير معروف: ${provider}`);
  return a;
}

export { kieAdapter, cometapiAdapter };
