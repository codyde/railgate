import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its source so tests don't require a
      // build of @railgate/shared first.
      "@railgate/shared": path.resolve(__dirname, "shared/src/index.ts"),
    },
  },
  test: {
    include: ["{shared,relay,cli}/src/**/*.test.ts"],
    environment: "node",
  },
});
