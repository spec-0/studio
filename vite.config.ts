import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri drives this dev server; fixed port + no auto-open so `tauri dev` can attach.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Scalar's Ask-AI agent calls api.scalar.com from module scope, so no
  // configuration flag can stop it — see src/scalar-agent-chat-stub.ts. A spec
  // for a private API must not generate a third-party request just by opening.
  resolve: {
    alias: [
      {
        find: /^@scalar\/agent-chat$/,
        replacement: fileURLToPath(new URL("./src/scalar-agent-chat-stub.ts", import.meta.url)),
      },
    ],
  },
  server: { port: 5173, strictPort: true },
  build: { target: "safari15", sourcemap: true },
});
