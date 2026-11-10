import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // مسار البناء قابل للتجاوز حتى لا يفسد بناء التحقق خادم التطوير المحلي.
  // على Vercel (بلا NEXT_DIST_DIR) يبقى الافتراضي .next كما هو معتاد.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // فحص الأنواع إلزامي أثناء البناء — لا تجاوز للأخطاء
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
  serverExternalPackages: ["@libsql/client", "libsql"],
};

export default nextConfig;
