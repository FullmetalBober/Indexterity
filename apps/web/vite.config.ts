import tailwindcss from "@tailwindcss/vite";
import { nitroV2Plugin } from "@tanstack/nitro-v2-vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 3000, host: true },
  plugins: [
    tanstackStart(),
    nitroV2Plugin(),
    // react's vite plugin must come after start's plugin
    viteReact(),
    tailwindcss(),
  ],
});
