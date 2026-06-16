/** @type {import('next').NextConfig} */
const nextConfig = {
  // The BFF talks to the opencode server over REST (global fetch) and touches
  // the filesystem in route handlers (runtime = "nodejs"). No special config
  // needed yet.
};

export default nextConfig;
