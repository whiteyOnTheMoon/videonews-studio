import { PRODUCT_NAME } from "@vns/shared";
import { readWorkerConfig } from "./config.js";

const config = readWorkerConfig();
console.info(
  `${PRODUCT_NAME} worker scaffold ready (render concurrency limit: ${config.maxRenderConcurrency}).`,
);
console.info("Job handling is not yet enabled. See P1-07 for BullMQ integration.");
