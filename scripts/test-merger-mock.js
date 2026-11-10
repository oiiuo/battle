#!/usr/bin/env node
/**
 * خدمة دمج اختبارية محلية (mock) — تطابق عقد Video Merger API v2 الموثق في المواصفة:
 *  POST   /api/jobs              → {jobId, status, statusUrl, processUrl, expiresAt}
 *  POST   /api/jobs/{id}/process → blocking ~10-15s → {status:"done", videoUrl, downloadUrl, size, duration, resolution, expiresAt}
 *  GET    /api/jobs/{id}         → {status, progress, videoUrl, downloadUrl}
 *  GET    /api/jobs/{id}/video   → بث MP4 بدعم Range (+ ?download=1)
 *  DELETE /api/jobs/{id}         → حذف فوري
 *  GET    /api/config            → الحدود العامة
 * للاختبار فقط — تستخدم ffmpeg النظام ولا تُنشر.
 */
const http = require("node:http");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 8787;
const ROOT = path.join(os.tmpdir(), "merger-mock");
fs.mkdirSync(ROOT, { recursive: true });

const jobs = new Map(); // jobId → { status, progress, videos, dir, outFile, error, expiresAt, meta }

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
const expiresAt = () => new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const jobId = () => "wk" + Math.random().toString(36).slice(2, 12);

function ffprobe(file) {
  return new Promise((resolve) => {
    execFile("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", file], (err, out) => {
      if (err) return resolve({ w: 640, h: 360, hasAudio: false, duration: 5 });
      try {
        const j = JSON.parse(out);
        const v = j.streams.find((s) => s.codec_type === "video");
        const a = j.streams.find((s) => s.codec_type === "audio");
        resolve({
          w: v ? v.width : 640,
          h: v ? v.height : 360,
          hasAudio: !!a,
          duration: parseFloat(j.format?.duration || v?.duration || "5"),
        });
      } catch {
        resolve({ w: 640, h: 360, hasAudio: false, duration: 5 });
      }
    });
  });
}

async function download(url, dest, onBytes) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`Download failed (HTTP ${r.status})`);
  // Response.body = Web ReadableStream — نستهلكه بـ for-await ونكتب في Node WriteStream
  const ws = fs.createWriteStream(dest);
  let n = 0;
  try {
    for await (const chunk of r.body) {
      n += chunk.length;
      if (n > 200 * 1024 * 1024) throw new Error("source exceeds 200MB limit");
      onBytes?.(n);
      if (!ws.write(chunk)) await new Promise((res) => ws.once("drain", res));
    }
  } finally {
    await new Promise((resolve, reject) => {
      ws.on("error", reject);
      ws.end(resolve);
    });
  }
  return dest;
}

/** دمج عبر filter_complex: scale+pad لأكبر دقة (حد 1080p)، fps=30، concat مع الصوت */
function mergeSources(job, onProgress) {
  return new Promise((resolve, reject) => {
    const inputs = [];
    const filters = [];
    let maxW = 0, maxH = 0;
    const infos = job.infos;
    for (const i of infos) {
      maxW = Math.max(maxW, i.w);
      maxH = Math.max(maxH, i.h);
    }
    maxW = Math.min(maxW, 1920) & ~1;
    maxH = Math.min(maxH, 1080) & ~1;

    const args = [];
    let inputCount = 0;
    infos.forEach((info, i) => {
      args.push("-i", info.file);
      const fileIdx = inputCount++; // index المدخل الملفي = i دائمًا هنا
      const filtersV = `[${fileIdx}:v]scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease,pad=${maxW}:${maxH}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`;
      if (info.hasAudio) {
        filters.push(filtersV, `[${fileIdx}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`);
      } else {
        // مصدر بلا صوت → مسار صامت بنفس مدته
        args.push("-f", "lavfi", "-t", String(info.duration), "-i", "anullsrc=r=44100:cl=stereo");
        const annIdx = inputCount++;
        filters.push(filtersV, `[${annIdx}:a]aresample=44100[a${i}]`);
      }
    });
    const pairs = infos.map((_, i) => `[v${i}][a${i}]`).join("");
    filters.push(`${pairs}concat=n=${infos.length}:v=1:a=1[vout][aout]`);

    const out = job.outFile;
    const total = infos.reduce((s, i) => s + i.duration, 0);
    const ff = spawn("ffmpeg", [
      "-y",
      ...args,
      "-filter_complex", filters.join(";"),
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-crf", "18", "-preset", "medium",
      "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
      "-movflags", "+faststart",
      "-progress", "pipe:1", "-nostats",
      out,
    ]);
    let buf = "";
    ff.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/out_time_us=(\d+)/);
        if (m && total > 0) {
          const p = Math.round((parseFloat(m[1]) / 1e6 / total) * 50) + 40; // 40-90 ترميز
          onProgress(Math.min(90, p));
        }
      }
    });
    ff.stderr.on("data", (d) => { job.lastStderr = String(d).slice(-400); });
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    ff.on("error", reject);
  });
}

async function runProcess(id) {
  const job = jobs.get(id);
  if (!job) return;
  try {
    job.status = "processing";
    job.progress = 2;
    fs.mkdirSync(job.dir, { recursive: true });
    const totalBytes = job.videos.length;
    let done = 0;
    for (let i = 0; i < job.videos.length; i++) {
      const file = path.join(job.dir, `src_${i}.mp4`);
      await download(job.videos[i], file, (n) => {
        // لا نعرف الحجم مسبقًا — نقيس بالبايتات نحو حد 200MB
        if (n > 200 * 1024 * 1024) throw new Error("source exceeds 200MB limit");
      });
      job.infos.push({ file, ...(await ffprobe(file)) });
      done++;
      job.progress = Math.round((done / totalBytes) * 40); // 0-40 سحب المصادر
    }
    await mergeSources(job, (p) => (job.progress = p));
    const st = fs.statSync(job.outFile);
    if (st.size > 150 * 1024 * 1024) throw new Error("output exceeds 150MB limit");
    const info = await ffprobe(job.outFile);
    job.status = "done";
    job.progress = 100;
    job.meta = { size: st.size, duration: info.duration, resolution: `${info.w}x${info.h}` };
    // بعد نجاح الدمج احذف المصادر — الناتج فقط هو المطلوب
    for (const i of job.infos) { try { fs.unlinkSync(i.file); } catch {} }
    job.infos = [];
  } catch (e) {
    job.status = "failed";
    job.error = e.message;
    job.progress = 0;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean); // api, jobs, :id, ...

  if (req.method === "GET" && url.pathname === "/api/config") {
    return send(res, 200, {
      version: "mock-1.0.0",
      limits: { maxSources: 10, sourceMaxMB: 200, outputMaxMB: 150, maxTotalDurationSec: 600, retentionHours: 24 },
    });
  }

  if (parts[0] !== "api" || parts[1] !== "jobs") return send(res, 404, { error: "not found" });
  const id = parts[2];
  const sub = parts[3];

  // إنشاء مهمة
  if (req.method === "POST" && !id && !sub) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let videos = [];
      try { videos = JSON.parse(body).videos; } catch {}
      if (!Array.isArray(videos) || videos.length < 2) return send(res, 400, { error: "videos must be an array of at least 2 URLs" });
      if (videos.length > 10) return send(res, 400, { error: "max 10 videos" });
      for (const v of videos) if (!/^https?:\/\//i.test(v)) return send(res, 400, { error: "invalid video url" });
      const jid = jobId();
      const dir = path.join(ROOT, jid);
      jobs.set(jid, {
        id: jid, videos, dir, infos: [], status: "queued", progress: 0,
        outFile: path.join(dir, "merged.mp4"), error: null, expiresAt: expiresAt(), meta: null,
      });
      send(res, 200, {
        jobId: jid, status: "queued",
        statusUrl: `http://127.0.0.1:${PORT}/api/jobs/${jid}`,
        processUrl: `http://127.0.0.1:${PORT}/api/jobs/${jid}/process`,
        expiresAt: expiresAt(),
      });
    });
    return;
  }

  const job = jobs.get(id);
  if (!job) return send(res, 404, { error: "job not found" });

  if (req.method === "POST" && sub === "process") {
    // blocking — يرد مباشرة بالنتيجة النهائية
    runProcess(id).then(() => {
      if (job.status === "done") {
        send(res, 200, {
          status: "done",
          videoUrl: `http://127.0.0.1:${PORT}/api/jobs/${id}/video`,
          downloadUrl: `http://127.0.0.1:${PORT}/api/jobs/${id}/video?download=1`,
          size: job.meta.size, duration: job.meta.duration, resolution: job.meta.resolution,
          expiresAt: job.expiresAt,
        });
      } else {
        send(res, 500, { error: job.error || "process failed" });
      }
    });
    return;
  }

  if (req.method === "GET" && !sub) {
    const base = { status: job.status, progress: job.progress };
    if (job.status === "done") {
      return send(res, 200, {
        ...base,
        videoUrl: `http://127.0.0.1:${PORT}/api/jobs/${id}/video`,
        downloadUrl: `http://127.0.0.1:${PORT}/api/jobs/${id}/video?download=1`,
        expiresAt: job.expiresAt,
      });
    }
    if (job.status === "failed") return send(res, 200, { ...base, error: job.error });
    return send(res, 200, base);
  }

  if (req.method === "GET" && sub === "video") {
    if (job.status !== "done" || !fs.existsSync(job.outFile)) return send(res, 404, { error: "video not ready" });
    const size = fs.statSync(job.outFile).size;
    const range = req.headers.range;
    const headers = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
    if (url.searchParams.get("download") === "1") headers["Content-Disposition"] = `attachment; filename="merged.mp4"`;
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      let start = m && m[1] ? parseInt(m[1]) : 0;
      let end = m && m[2] ? parseInt(m[2]) : size - 1;
      end = Math.min(end, size - 1);
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      headers["Content-Length"] = end - start + 1;
      res.writeHead(206, headers);
      fs.createReadStream(job.outFile, { start, end }).pipe(res);
    } else {
      headers["Content-Length"] = size;
      res.writeHead(200, headers);
      fs.createReadStream(job.outFile).pipe(res);
    }
    return;
  }

  if (req.method === "DELETE" && !sub) {
    try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch {}
    jobs.delete(id);
    return send(res, 200, { ok: true });
  }

  send(res, 405, { error: "method not allowed" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`merger-mock listening on http://127.0.0.1:${PORT}`));
