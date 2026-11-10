# 🎨 MCP Media Generator — خادم MCP لتوليد الصور والفيديو + دمج المقاطع

خادم **MCP** (Model Context Protocol) يجمع ثلاث قدرات في أداة واحدة، مع لوحة إدارة عربية RTL:

1. **توليد صور** من وصف نصي — الموديل المدمج `gpt-image-2-6/flare-text-to-image`.
2. **توليد فيديو** بصوت متزامن أصلي (حوار/مؤثرات/موسيقى) — الموديل المدمج `grok-imagine-video-1-5-preview` (مع image-to-video اختياري).
3. **دمج عدة مقاطع فيديو** في مقطع واحد بترتيب محدد (حتى 10 مقاطع) عبر خدمة Video Merger API v2.

يعرض الخادم **5 أدوات** يستدعيها أي عميل MCP: ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK.

---

## ⭐ القواعد الجوهرية

- **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر إطلاقًا؛ تُخزَّن روابط النتائج في قاعدة البيانات فقط.
- **تبديل مفاتيح تسلسلي صارم** بترتيب الإضافة (`created_at ASC, id ASC`) — ليس round-robin.
- **لا توقف عند نفاد الرصيد**: انتقال تلقائي للمفتاح التالي واستئناف **نفس المهمة بنفس `task_id`**.
- **نموذج الذكاء الاصطناعي لا يرى أبدًا** أخطاء المفاتيح أو الرصيد — التبديل صامت تمامًا من وجهة نظره.
- مهمة فشلت على كل المفاتيح تبقى `processing` («بانتظار توفر مفتاح صالح…») وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة ~45 ثانية).
- أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx) = فشل نهائي فوري؛ أخطاء الشبكة = مؤقتة وتستمر بالاستعلام.
- ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة — يُنبَّه المستخدم للتنزيل سريعًا.
- **إخفاء المفاتيح إلزامي** في كل الاستجابات والسجلات (`maskKey`).

---

## 🧰 التقنيات

- **Next.js** (App Router) + **TypeScript** + **Tailwind CSS** (مكوّنات shadcn/ui).
- **`@modelcontextprotocol/sdk`** رسميًا — `McpServer` + `WebStandardStreamableHTTPServerTransport` على المسار `/mcp` (لا JSON-RPC يدويًا).
- **`@libsql/client`** مع قاعدة **Turso** عبر HTTP الخالص (يحوّل `libsql://` إلى `https://` تلقائيًا) — متوافق مع Vercel serverless، بلا ملفات SQLite محلية.

---

## 🖥️ الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة وإرجاع الرابط جاهزًا إن اكتملت داخل نافذة الانتظار، وإلا `task_id` |
| `generate_video` | توليد فيديو بصوت متزامن؛ نافذة انتظار قصيرة مع بث تقدم ثم `task_id` |
| `merge_videos` | دمج `urls` (روابط مباشرة) أو `task_ids` (مهام فيديو مكتملة) بالترتيب — بحد 10 مقاطع وبلا resolution/fps (الناتج مثبّت من الخدمة) |
| `get_task` | تتبع أي مهمة (توليد أو دمج) وتحديثها حية من المزود/الخدمة |
| `list_media` | أحدث الوسائط المخزّنة بروابطها مرتبة من الأحدث (بدون إعادة توليد) |

نتائج الاستدعاء **بالعربية**، وأوصاف الأدوات بالإنجليزية (يقرأها نموذج العميل)، ومع كل انتظار تُبثّ **Progress notifications** كل ~3 ثوانٍ عند توفير `_meta.progressToken`.

**SERVER_INSTRUCTIONS** تُرسل مع `initialize` وتشرح للنموذج سير العمل: إظهار الروابط فورًا عند الاكتمال، وإلا المتابعة بـ `get_task` كل ~10 ثوانٍ دون الحديث عن مفاتيح أو أرصدة أبدًا.

---

## 🗄️ قاعدة البيانات (Turso)

جدولان يُنشآن تلقائيًا عند أول وصول (`ensureSchema` — بلا أداة migrations):

- `tasks` — كل مهمة: المزود، معرّف المزود، آخر مفتاح، الموديل، النوع، المعطيات الأصلية (لإعادة الإنشاء عند التبديل)، الحالة، التقدم، روابط النتائج، وسجل المحاولات `attempts_json`.
- `api_keys` — المفاتيح: المزود (kie/cometapi)، التسمية، الحالة (`active` / `exhausted` / `disabled`)، عدّادات الاستخدام/النجاح/الفشل، آخر خطأ وآخر استخدام.

### تصنيف الأخطاء الموحد (`classifyProviderError`)

| الفئة | الشرط | الإجراء |
|---|---|---|
| `disabled` | 401/403 أو رسالة مصادقة | تعطيل المفتاح تلقائيًا → المفتاح التالي |
| `exhausted` | 402 أو كلمات الرصيد (تُفحص **قبل** 400) | تعليم المفتاح `exhausted` (يبقى في القاعدة) → التالي |
| `provider` | موديل غير مدعوم | الانتقال للمزود التالي |
| `params` | 400/422 معطيات | **توقف فورًا** — تبديل المفاتيح لن يحلها |
| `temporary` | 429/5xx/شبكة | الانتقال للتالي والمفتاح يبقى سليمًا |

---

## 🧩 واجهة الويب (لوحة واحدة)

- **هيدر الحالة**: شارة «Turso متصل / غير متصل» + حالة خدمة الدمج + حماية Bearer.
- **مدير المفاتيح**: إضافة (مزود/تسمية/مفتاح) مع رفض التكرار، قائمة مُقنَّعة دائمًا بأزرار تعطيل–تنشيط–حذف، عدّادات وآخر خطأ.
- **لوحة المهام**: إحصائيات (إجمالي/مكتملة/فاشلة/جارية) + قائمة تُحدَّث تلقائيًا كل 5 ثوانٍ مع أشرطة تقدم وروابط وأزرار نسخ.
- **بطاقة ربط السيرفر**: رابط `<origin>/mcp` بزر نسخ + JSON جاهز لثلاث تبويبات (ChatGPT / Claude Desktop / Cursor-Windsurf-Cline) + رقائق الأدوات الخمس + ملاحظة بث التقدم.

### مسارات API

| المسار | الوظيفة |
|---|---|
| `GET /api/health` | `ok` + `database` + `mcpEndpoint` + `models` + `merger{base,healthy}` + `authRequired` |
| `GET /api/keys` | القائمة كاملة **مقنّعة** |
| `POST /api/keys` | إضافة `{provider, api_key, label?}` — رفض التكرار 409 |
| `PATCH /api/keys/{id}` | تعطيل/تنشيط يدوي `{status}` |
| `DELETE /api/keys/{id}` | حذف نهائي |
| `GET /api/tasks` | إحصائيات + أحدث 20 مهمة للوحة |
| `POST /mcp` | رسائل JSON-RPC (Streamable HTTP) |
| `DELETE /mcp` | إنهاء الجلسة (`mcp-session-id`) |

---

## 🚀 التشغيل محليًا

```bash
bun install            # أو npm install
cp .env.example .env.local   # ثم املأ القيم
bun run dev            # http://localhost:3000
```

اختبارات المشروع (اختيارية لكن مفيدة):

```bash
bun scripts/test-exhausted-402.ts     # اختبار مفتاح 402: تبديل تسلسلي + بقاء المفتاح exhausted
node scripts/test-merger-mock.js      # خدمة دمج اختبارية محلية على 8787 (تطابق عقد الـAPI)
bun scripts/cleanup-test-data.mjs     # تنظيف آثار الاختبار من القاعدة
```

---

## ☁️ النشر على Vercel

1. ارفع المستودع إلى GitHub ثم من Vercel: **Add New → Project** واختر المستودع.
2. أضف متغيرات البيئة (Settings → Environment Variables):

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | `libsql://<db>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | ✅ | توكن بصلاحيات كتابة (`turso db tokens create <db>`) |
| `MERGER_API_BASE` | للدمج | رابط خدمة دمج الفيديو المنشورة (Vercel) |
| `MCP_ACCESS_TOKEN` | اختياري | إن ضُبط يُطلب `Authorization: Bearer` على `/mcp` |
| `KIE_IMAGE_MODEL` `KIE_VIDEO_MODEL` `COMETAPI_IMAGE_MODEL` `COMETAPI_VIDEO_MODEL` | اختياري | تجاوز أسماء الموديلات |

3. Deploy — كل شيء يعمل عبر HTTP (libSQL + `/mcp` streaming) وبلا أي ملف محلي؛ `.env*` مستثنى من Git منذ اليوم الأول.

### إنشاء قاعدة Turso من الصفر

```bash
turso db create <name>
turso db show <name> --url      # هذا هو TURSO_DATABASE_URL
turso db tokens create <name>   # هذا هو TURSO_AUTH_TOKEN
```

### ربط العملاء بعد النشر

- **ChatGPT**: Settings → Connectors → Create → Custom MCP server → ضع `https://<domain>/mcp` في «Server URL».
- **Claude Desktop** (`claude_desktop_config.json`):

```json
{ "mcpServers": { "media-generator": { "type": "http", "url": "https://<domain>/mcp" } } }
```

- **Cursor / Windsurf / Cline** (`mcp.json`): نفس الصيغة الأولى (بلا `"type"`).
- عند ضبط `MCP_ACCESS_TOKEN` أضف `"headers": { "Authorization": "Bearer <TOKEN>" }`.

---

## 🧪 اختبارات e2e أُجريت فعليًا (أدلة)

1. `tsc --noEmit` نظيف + `next build` ناجح بفحص أنواع كامل.
2. `GET /api/health` → `ok:true` + `database:"turso-connected"` + `merger.healthy:true` (مع الخدمة الاختبارية).
3. `tools/list` يعرض الأدوات الخمس بمخططات مطابقة (`merge_videos` بلا resolution/fps وبحد minItems:2/maxItems:10).
4. توليد صورة حقيقي بمفتاح kie.ai → رابط يعمل (HTTP 200).
5. توليد فيديو حقيقي → `task_id` → متابعة `get_task` كل 10 ثوانٍ → رابط MP4 صالح.
6. تبديل تسلسلي: مفتاح خاطئ أولًا ثم صحيح → نفس المهمة اكتملت على الثاني، الخاطئ صار `disabled`، والعميل لم يرَ أي ذكر للمفاتيح.
7. مفتاح 402 (محاكاة) → حالة `exhausted` ويبقى في القاعدة دون عرقلة التالي (`scripts/test-exhausted-402.ts` — 4/4).
8. دمج e2e بمقطعين عامين بدقتين مختلفتين (360p+720p) → MP4 نهائي بنفس دقة الخدمة، مع بث Range (206) وتحميل مباشر، والناتج 1280x720/20 ثانية/صوت موجود/h264.
9. `merge_videos` يرفض مقطعًا واحدًا وأكثر من 10 برسائل عربية، ويحل `task_ids` بالترتيب.
10. `list_media` يعيد المهام المخزّنة بروابطها من الأحدث.
11. الواجهة: إضافة/تعطيل/حذف مفتاح عبر المتصفح، لوحة مهام حية، بطاقة ربط كاملة، RTL عربي سليم.
12. بيئة إنتاج محاكاة بالكامل: لا ملفات محلية — قاعدة Turso عبر HTTP فقط + `/mcp` streaming.

---

## ⚠️ ملاحظات

- **خدمة الدمج**: هذا المستودع هو خادم MCP؛ الـدمج يحتاج خدمة Video Merger API v2 منشورة (مشروع مستقل بنفس المواصفة) — ضع رابطها في `MERGER_API_BASE`. للمحاكاة محليًا: `node scripts/test-merger-mock.js`.
- **CometAPI**: المحوّل مُنفَّذ وفق نمط وثائقهم الحالية (`/v1/images/generations` المتزامن للصور و`/v1/videos/generations` + `GET /v1/videos/{id}` للفيديو) — يتفعّل تلقائيًا عند إضافة مفتاح CometAPI من اللوحة.
- **Vercel**: نافذة الانتظار تُقصَّر إلى 50 ثانية على Vercel تلقائيًا (`maxDuration=60`) حتى لا يُقتل الطلب — العميل يتابع بـ `get_task` وفق التصميم غير المتزامن.
- **الأمان**: لا تضع أسرارًا في الكود أو Git؛ إن شاركت التوكنات في أي مكان يُفضَّل تدويرها لاحقًا.
