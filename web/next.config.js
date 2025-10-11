/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    externalDir: true, // keep for importing ../../agent
  },
  optimizeFonts: false, // ← disable Next’s font pipeline entirely
};

module.exports = nextConfig;
