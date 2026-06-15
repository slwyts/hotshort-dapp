import type { NextConfig } from "next";

const workerUrl = process.env.WORKER_URL?.replace(/\/$/, "");

const config: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  async rewrites() {
    if (!workerUrl) return [];
    return [
      {
        source: "/api/:path*",
        destination: `${workerUrl}/:path*`,
      },
    ];
  },
};

export default config;
