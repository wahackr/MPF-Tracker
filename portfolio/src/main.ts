import { Router } from "express";
import { registerAccountsRoutes } from "./routes/accounts.js";
import { registerHoldingsRoutes } from "./routes/holdings.js";
import { registerAllocationsRoutes } from "./routes/allocations.js";
import { registerPlansRoutes } from "./routes/plans.js";
import { registerReconciliationsRoutes } from "./routes/reconciliations.js";

export function portfolioRouter(): Router {
  const router = Router();
  registerAccountsRoutes(router);
  registerHoldingsRoutes(router);
  registerAllocationsRoutes(router);
  registerPlansRoutes(router);
  registerReconciliationsRoutes(router);
  return router;
}
