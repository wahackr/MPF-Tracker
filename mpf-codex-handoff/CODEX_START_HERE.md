# Codex — Start Here

You are implementing the MPF Portfolio Tracker for the user's existing project at `./src`.

1. Read `IMPLEMENTATION.md` **in full** and inspect the existing repository, including any `AGENTS.md` instructions.
2. Real source payloads are in `fixtures/`. Never modify them or invent an API response schema not provided.
3. Implement **Phase 0 and Phase 1 first**, run the specified tests, and report files changed, commands executed, tests passing/failing, and remaining blockers. Then proceed phase by phase only when the preceding phase is sound.
4. Keep four independent service containers (crawler, portfolio, purchase, valuation) and one PostgreSQL database. Existing n8n triggers each service independently via internal HTTP; **crawler sync must not automatically trigger purchases or valuation**.
5. Maintain a clear boundary between verified holdings and estimated fund purchases. All financial math uses Decimal/NUMERIC, not floating point.
6. Preserve existing working files where possible, avoid exposing host ports, don't modify running n8n workflows without permission, and do not claim that any live API integration works unless tested.
7. A real `Manulife fundhistory` JSON response fixture is **not included**. Live-fetch and inspect one before implementing its parser, or mark it blocked/unverified if external access fails.

Deliver working code, migrations, Docker Compose, tests, README, example n8n workflows and a clear phase-by-phase implementation report, per `IMPLEMENTATION.md`.
