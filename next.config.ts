import type { NextConfig } from "next";

// Static export for GitHub Pages. The site is served from /<repo>, so the
// deploy workflow sets PAGES_BASE_PATH; local dev and builds use the root.
const basePath = process.env.PAGES_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
