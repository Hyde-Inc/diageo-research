import type { NextConfig } from "next";

// Diageo Hypothesis Workbench: FastAPI lives on a sibling port. We
// rewrite /api/workbench/* → http://127.0.0.1:8765/* so the browser
// hits same-origin (no CORS). Override the host with WORKBENCH_API_BASE
// in .env.local for a remote/staging backend.
const WORKBENCH_API_BASE =
  process.env.WORKBENCH_API_BASE || "http://127.0.0.1:8765";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/workbench/:path*",
        destination: `${WORKBENCH_API_BASE}/:path*`,
      },
    ];
  },
};

export default nextConfig;
