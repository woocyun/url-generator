import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The shared package is published as TypeScript source, so Next has to
  // compile it rather than treat it as a prebuilt dependency.
  transpilePackages: ['@url-generator/shared'],

  // Emits a self-contained server bundle, which keeps the production image
  // small enough to skip shipping node_modules.
  output: 'standalone',

  // Next is run from apps/web, but the workspace root is two levels up.
  // Without this it traces the wrong root and misses hoisted dependencies.
  outputFileTracingRoot: path.join(process.cwd(), '../..'),
};

export default nextConfig;
