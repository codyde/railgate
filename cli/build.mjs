import { build } from "esbuild";
import { readFileSync } from "fs";
import { chmodSync } from "fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "dist/railgate.cjs",
  external: ["@clack/prompts", "commander", "ws"],
  define: {
    __RAILGATE_VERSION__: JSON.stringify(pkg.version),
  },
});

chmodSync("dist/railgate.cjs", 0o755);
