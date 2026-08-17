import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile(fileURLToPath(new URL("apps/api/.env", import.meta.url)));
} catch {
  process.env.WARRANT_NO_LOCAL_ENV = "1";
}

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
  },
});
