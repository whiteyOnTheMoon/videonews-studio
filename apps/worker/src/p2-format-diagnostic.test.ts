import test from "node:test";
import { readFileSync } from "node:fs";
import prettier from "prettier";

test("emit exact formatter delta for event candidate helper", async () => {
  const name = "src/offline-editorial-pipeline.ts";
  const source = readFileSync(name, "utf8");
  const formatted = await prettier.format(source, { filepath: name, printWidth: 100, singleQuote: false, trailingComma: "all", semi: true });
  const marker = "/**\n * Candidate-only near-duplicate clustering.";
  console.log("P2_FORMAT_EXPECTED_START");
  console.log(formatted.slice(formatted.indexOf(marker)));
  console.log("P2_FORMAT_EXPECTED_END");
});
