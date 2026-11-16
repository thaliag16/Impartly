import type { NextConfig } from "next";

const ONNX = "node_modules/onnxruntime-node/bin/napi-v3";

const nextConfig: NextConfig = {
  // kokoro-js imports Node's file modules even in its browser entry. In the
  // browser they are never called, so point them at an empty module.
  turbopack: {
    resolveAlias: {
      "fs/promises": { browser: "./lib/empty.ts" },
      path: { browser: "./lib/empty.ts" },
    },
  },
  // The speech packages load native code and must not be bundled.
  serverExternalPackages: ["kokoro-js", "@huggingface/transformers", "onnxruntime-node", "sharp"],
  // The voice test runs the speech model on several CPU threads, which browsers
  // only allow on pages that opt in to cross-origin isolation.
  async headers() {
    return [
      {
        source: "/spike/voice",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
      {
        // An isolated page may only start a worker whose script carries the
        // same policy, so the app's own script files declare it too.
        source: "/_next/static/:path*",
        headers: [
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
    ];
  },
  // File tracing misses files that are loaded at run time rather than imported:
  // the speech runtime's shared library and Kokoro's voice files.
  outputFileTracingIncludes: {
    "/api/speech-test": [
      `${ONNX}/linux/x64/libonnxruntime.so.1`,
      `${ONNX}/linux/x64/libonnxruntime_providers_shared.so`,
      "node_modules/kokoro-js/voices/**",
    ],
  },
  // Keep the function small: drop GPU libraries (343 MB) and other platforms' binaries.
  outputFileTracingExcludes: {
    "/api/speech-test": [
      `${ONNX}/linux/x64/libonnxruntime_providers_cuda.so`,
      `${ONNX}/linux/x64/libonnxruntime_providers_tensorrt.so`,
      `${ONNX}/linux/arm64/**`,
      `${ONNX}/darwin/**`,
      `${ONNX}/win32/**`,
    ],
  },
};

export default nextConfig;
