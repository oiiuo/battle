/** واجهة موحدة لكل مزود — أي خطأ يُرمى كـ ProviderError ليُصنَّف في classify.ts */
import type { ProviderId } from "../models";

export interface ProviderTaskInput {
  [k: string]: unknown;
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو وبعض الصور): تعيد معرّف المهمة لدى المزود */
  createTask(key: string, providerModel: string, input: ProviderTaskInput): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (يعيد الروابط فورًا) */
  createImageSync?(key: string, providerModel: string, input: ProviderTaskInput): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(
    key: string,
    providerTaskId: string
  ): Promise<{
    status: "processing" | "completed" | "failed";
    urls?: string[];
    error?: string;
    progress?: number;
  }>;
}

export type { ProviderId };
