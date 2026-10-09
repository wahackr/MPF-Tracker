import crypto from "node:crypto";
import { NextFunction, Request, Response } from "express";

const apiKey = process.env.API_KEY ?? "REPLACE_ME";

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.header("X-API-Key");
  if (!supplied) {
    res.status(401).json({ detail: "Invalid or missing API key" });
    return;
  }
  const expectedBuf = Buffer.from(apiKey);
  const suppliedBuf = Buffer.from(supplied);
  if (expectedBuf.length !== suppliedBuf.length || !crypto.timingSafeEqual(expectedBuf, suppliedBuf)) {
    res.status(401).json({ detail: "Invalid or missing API key" });
    return;
  }
  next();
}
