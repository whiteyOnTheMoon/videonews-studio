import { createServer, type Server } from "node:http";
import { createHealth } from "@vns/shared";
import type { AdminAuth } from "./auth.js";

export function createApiServer(options: { auth?: AdminAuth } = {}): Server {
  return createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");

    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200);
      response.end(JSON.stringify(createHealth("api")));
      return;
    }

    if (options.auth) {
      void options.auth
        .handle(request, response)
        .then((handled) => {
          if (!handled) {
            response.writeHead(404);
            response.end(JSON.stringify({ error: "not_found" }));
          }
        })
        .catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end(JSON.stringify({ error: "internal_error" }));
        });
      return;
    }

    response.writeHead(404);
    response.end(JSON.stringify({ error: "not_found" }));
  });
}
