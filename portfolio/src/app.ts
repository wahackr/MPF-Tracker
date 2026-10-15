import express, { NextFunction, Request, Response } from "express";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";

import { requireApiKey } from "./libs/auth.js";
import { healthCheck } from "./libs/db.js";
import { portfolioRouter } from "./main.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

/**
 * GET /health
 * Reports whether the Portfolio API can connect to PostgreSQL. No parameters or
 * API key are required.
 */
app.get("/health", async (_req, res) => {
  const ok = await healthCheck();
  if (ok) {
    res.json({ service: "portfolio", status: "ready", database: "up" });
    return;
  }
  res.status(503).json({ service: "portfolio", status: "not_ready", database: "down" });
});

app.use("/v1", requireApiKey, portfolioRouter());

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    res.status(400).json({ detail: "Invalid request payload", issues: error.issues });
    return;
  }
  const status = (error as Error & { status?: number }).status ?? 500;
  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(status).json({ detail: message });
});

export { app };
