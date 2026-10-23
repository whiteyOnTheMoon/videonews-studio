import { createServer, type Server } from "node:http";
import { createHealth } from "@vns/shared";

export function createApiServer(): Server {
  return createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");

    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200);
      response.end(JSON.stringify(createHealth("api")));
      return;
    }

    response.writeHead(404);
    response.end(JSON.stringify({ error: "not_found" }));
  });
}
