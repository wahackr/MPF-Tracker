import express, { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { requireApiKey } from "./auth.js";
import { healthCheck } from "./db.js";
import { portfolioRouter } from "./routes.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

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

const port = Number(process.env.PORT ?? "8000");
app.listen(port, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`portfolio listening on :${port}`);
});
