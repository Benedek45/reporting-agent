/** @type {import('next').NextConfig} */
const nextConfig = {
  // BFF route handlers spawn/connect to the opencode server and touch the
  // filesystem (workspaces). Keep server-only deps out of the client bundle.
  serverExternalPackages: ["@opencode-ai/sdk"],
};

export default nextConfig;
