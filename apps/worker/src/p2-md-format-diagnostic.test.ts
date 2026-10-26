import { readFileSync } from "node:fs";
import test from "node:test";
import prettier from "prettier";

test("temporary exact markdown formatting output", async () => {
  const source = readFileSync("../../docs/P2-02-03_POSTGRES_HANDOFF_0028.md", "utf8");
  const formatted = await prettier.format(source, {
    parser: "markdown",
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    printWidth: 100,
  });
  console.log("P2_MD_FORMAT_BASE64:" + Buffer.from(formatted).toString("base64"));
});
