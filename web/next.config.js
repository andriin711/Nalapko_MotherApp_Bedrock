// web/next.config.js
const path = require("path");

/** @type {import('next').NextConfig} */
module.exports = {
  experimental: { externalDir: true },
  turbopack: {
    // Point Turbopack at your repo root to avoid “multiple lockfiles” confusion
    root: path.resolve(__dirname, ".."),
  },
  // If you previously hit font fetch warnings, this avoids remote font optimization
  optimizeFonts: false,
};
