import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      ignored: ["**/release/**"]
    },
    proxy: {
      "/api": {
        target: process.env.REVIEW_API_URL || "http://127.0.0.1:4517",
        changeOrigin: false,
        // The local API requires a capability token. The dev launcher passes it here so the page
        // served by Vite does not need the cookie the app itself bootstraps.
        configure(proxy) {
          const capability = process.env.REVIEW_API_TOKEN || "";
          if (!capability) return;
          proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("X-Review-Api-Token", capability));
        }
      }
    }
  }
});
