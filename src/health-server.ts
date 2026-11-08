import { createServer, type Server } from "node:http";
import type { Pool } from "pg";
import { metricsRegistry, setPoolMetrics } from "./metrics.js";

export type HealthServerOptions = {
  port: number;
  pool: Pool;
  checkReady: () => Promise<{ db: boolean; redis: boolean }>;
  isHealthy?: () => boolean;
};

export type HealthServer = {
  server: Server;
  ready: Promise<void>;
  close: () => Promise<void>;
};

export function startHealthServer(options: HealthServerOptions): HealthServer {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/healthz") {
        const healthy = options.isHealthy?.() ?? true;
        res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: healthy ? "ok" : "shutting_down" }));
        return;
      }

      if (req.method === "GET" && req.url === "/ready") {
        const checks = await options.checkReady().catch(() => ({ db: false, redis: false }));
        const ready = checks.db && checks.redis;
        res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: ready ? "ready" : "not_ready", checks }));
        return;
      }

      if (req.method === "GET" && req.url === "/metrics") {
        setPoolMetrics(options.pool);
        res.writeHead(200, { "content-type": metricsRegistry.contentType });
        res.end(await metricsRegistry.metrics());
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    })().catch(() => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error" }));
    });
  });

  const ready = new Promise<void>((resolve) => {
    server.listen(options.port, "0.0.0.0", resolve);
  });

  return {
    server,
    ready,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
