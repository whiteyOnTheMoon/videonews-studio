import { readFileSync } from "node:fs";
import test from "node:test";
import prettier from "prettier";

test("print transient exact formatting expectations", async () => {
  for (const [file, parser] of [
    ["src/dormant-feed-candidate-projector.test.ts", "typescript"],
    ["../../docs/P2-02-03_POSTGRES_HANDOFF_0028.md", "markdown"],
  ] as const) {
    const source = readFileSync(file, "utf8");
    const formatted = await prettier.format(source, {
      parser,
      semi: true,
      singleQuote: false,
      trailingComma: "all",
      printWidth: 100,
    });
    console.log("P2_FORMAT_BEGIN:" + parser);
    console.log(formatted);
    console.log("P2_FORMAT_END:" + parser);
  }
});
