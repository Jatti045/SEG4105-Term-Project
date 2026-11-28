import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const page = (file) => fileURLToPath(new URL(file, import.meta.url));

// Two pages: the manager dashboard (index.html) and the fridge simulator.
// In development, /api requests go to the FastAPI backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.API_URL ?? "http://localhost:8000",
    },
  },
  build: {
    rollupOptions: {
      input: {
        dashboard: page("./index.html"),
        simulator: page("./simulator.html"),
      },
    },
  },
});
