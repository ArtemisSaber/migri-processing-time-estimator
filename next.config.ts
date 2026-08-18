import type { NextConfig } from "next";

const pagesBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

if (pagesBasePath && !pagesBasePath.startsWith("/")) {
  throw new Error("NEXT_PUBLIC_BASE_PATH must be empty or start with a slash.");
}

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: pagesBasePath,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
