import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { nitroV2Plugin } from "@tanstack/nitro-v2-vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3000,
    host: true,
    // The browser calls the api on whatever origin served the page, so a bare
    // `turbo dev` on the host — no ingress, no compose proxy — needs the dev
    // server to forward /api itself. Four lines, and it means every way of
    // running this app is the same one-origin shape.
    //
    // In compose nginx has already routed /api to the api and this never fires;
    // API_URL is read anyway so the two cannot disagree about where the api is.
    proxy: {
      "/api": { target: process.env.API_URL ?? "http://localhost:3001", ws: true },
    },
  },
  // shadcn's generated components import through "~" (see components.json);
  // tsconfig already maps it, Vite needs telling too.
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Bundle internal + CJS deps into the SSR output so nitro never has to trace
  // them as externals (their exports maps break its dependency copy).
  ssr: { noExternal: [/^@repo\//, "zod"] },
  plugins: [
    tanstackStart(),
    // Pin nitro's defaults to the date this app was built against, instead of
    // letting it fall back to 2024-04-03 and warn on every build.
    nitroV2Plugin({ compatibilityDate: "2026-07-31" }),
    // react's vite plugin must come after start's plugin
    viteReact(),
    tailwindcss(),
  ],
});
