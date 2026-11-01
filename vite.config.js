import { defineConfig } from "vite";
import { offlineBuild } from "./scripts/pwa-build.mjs";
export default defineConfig({
  root: "web",
  base: "/",
  // Shared installation components must use the host application's React.
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [offlineBuild({ variant: "portable", icons: [
    { src: "/demo-assets/vorton-graphite-v6.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/demo-assets/vorton-graphite-v6-1024.png", sizes: "1024x1024", type: "image/png", purpose: "any" },
    { src: "/demo-assets/vorton-graphite-v6-180.png", sizes: "180x180", type: "image/png", purpose: "any" },
  ] })],
  build: { outDir: "../dist", assetsDir: "demo-assets", assetsInlineLimit: 0, emptyOutDir: true },
});
