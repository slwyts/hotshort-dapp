import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  images: {
    unoptimized: true,
  },
};

export default config;
