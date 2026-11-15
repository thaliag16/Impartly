import type { NextConfig } from "next";

const ONNX = "node_modules/onnxruntime-node/bin/napi-v3";

const nextConfig: NextConfig = {
  // The speech packages load native code and must not be bundled.
  serverExternalPackages: ["kokoro-js", "@huggingface/transformers", "onnxruntime-node", "sharp"],
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
