/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    externalDir: true, // allow ../../agent import from within web/
  },
};

module.exports = nextConfig;
