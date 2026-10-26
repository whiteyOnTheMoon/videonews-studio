import { readFileSync } from "node:fs";
import test from "node:test";
import prettier from "prettier";

test("temporary precise formatter output for new editorial source files", async () => {
  for (const file of [
    "src/bounded-editorial-production.ts",
    "src/bounded-editorial-production.test.ts",
    "src/dormant-editorial-checkpoint-store.ts",
    "src/dormant-editorial-checkpoint-store.test.ts",
  ]) {
    const formatted = await prettier.format(readFileSync(file, "utf8"), {
      filepath: file,
      printWidth: 100,
      semi: true,
      trailingComma: "all",
      singleQuote: false,
    });
    console.log("P2_FORMATTED_FILE:" + file + ":" + Buffer.from(formatted).toString("base64"));
  }
});
