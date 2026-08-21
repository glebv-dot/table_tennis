import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lint is run separately (npm run lint); don't let it block production builds.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
