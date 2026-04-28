import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  minify: false,
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
});
