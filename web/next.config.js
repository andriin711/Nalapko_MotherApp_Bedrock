/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    externalDir: true, // allow importing ../../agent from within /web
  },
};

module.exports = nextConfig;
