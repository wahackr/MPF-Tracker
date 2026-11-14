import crypto from "node:crypto";
import { NextFunction, Request, Response } from "express";

const apiKey = process.env.API_KEY ?? "REPLACE_ME";

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.header("X-API-Key");
  if (!supplied) {
    res.status(401).json({ detail: "Invalid or missing API key" });
    return;
  }
  const expected = Buffer.from(apiKey);
  const provided = Buffer.from(supplied);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    res.status(401).json({ detail: "Invalid or missing API key" });
    return;
  }
  next();
}
