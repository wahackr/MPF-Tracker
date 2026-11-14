import express, { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { requireApiKey } from "./libs/auth.js";
import { healthCheck } from "./libs/db.js";
import { crawlerRouter } from "./main.js";
import { IdempotencyConflict } from "./libs/jobs.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  const ok = await healthCheck();
  if (ok) {
    res.json({ service: "crawler-api", status: "ready", database: "up" });
    return;
  }
  res.status(503).json({ service: "crawler-api", status: "not_ready", database: "down" });
});

app.use("/v1", requireApiKey, crawlerRouter());

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    res.status(400).json({ detail: "Invalid request payload", issues: error.issues });
    return;
  }
  if (error instanceof IdempotencyConflict) {
    res.status(409).json({ detail: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(500).json({ detail: message });
});

export { app };
