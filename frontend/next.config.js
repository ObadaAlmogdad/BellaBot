/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
  async rewrites() {
    const ttsApiUrl = process.env.TTS_API_URL ?? "http://localhost:8000";
    return [
      {
        source: "/api/tts/:path*",
        destination: `${ttsApiUrl}/:path*`,
      },
      {
        source: "/audio/:path*",
        destination: `${ttsApiUrl}/audio/:path*`,
      },
    ];
  },
};

export default config;
