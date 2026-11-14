# n8n scheduling drafts

Issue: [#26](https://github.com/wahackr/MPF-Tracker/issues/26).
These are inactive JSON imports, not deployed workflows. No n8n service is added to Compose.

| Import | Use |
| --- | --- |
| `daily-pipeline.json` | Recommended: download → poll until successful → purchase estimates → rebuild stale valuations → save snapshot |
| `download.json` | Standalone download and polling |
| `purchase.json` | Standalone due purchase estimates |
| `valuation.json` | Standalone stale rebuild and snapshot |

Every draft has a Manual Trigger and a daily **06:00 Asia/Hong_Kong** Schedule Trigger. Publish/activate **only `daily-pipeline.json`** for routine automation. The other drafts support manual recovery or a deliberately customized scheduling arrangement. Independent schedules have no dependency checks: spacing their start times cannot guarantee that prices or purchases are ready. Do not run these workflows concurrently for the same accounts, including manual executions.

## Import and configure

1. Import the desired JSON using n8n's **Import from File** workflow menu. Drafts use built-in Schedule Trigger 1.2, Manual Trigger 1, HTTP Request 4.2, Code 2, If 2.2, Wait 1.1, and Sticky Note 1 nodes. Use an n8n release supporting these versions; inspect imported nodes for warnings. These drafts have offline checks, but have not been imported or executed in a live n8n instance.
2. Create an n8n **Header Auth** credential: header name `X-API-Key`, value equal to this stack's `API_KEY`. Select it in **every HTTP Request node** (Authentication: Generic Credential Type → Header Auth). Credential IDs and secrets are deliberately absent from the exports. No environment-variable access is required.
3. Attach self-hosted n8n to the existing Compose `N8N_NETWORK` (default `automation`). For an existing container, for example: `docker network connect automation YOUR_N8N_CONTAINER`. Configure this network persistently in n8n's own Compose deployment as well. The defaults use `http://mpf-crawler-api:8000`, `http://mpf-purchase:8000`, and `http://mpf-valuation:8000`.
4. Edit the **Configuration** Code node's public settings if required. External n8n installations need reachable URLs for the published API ports (`8001`, `8003`, `8004` by default); `localhost` inside n8n refers to n8n itself. Leave `accountId` empty for all accounts, or supply one UUID. Set `provider` (`all`, `hsbc`, `manulife`), `rollingDays` (1–28), and `maxPolls` (positive integer). The defaults sync both providers over seven days and allow 60 status checks.
5. Check that funds, account baselines, allocations, and contribution plans have been configured as described in the [root README](../../README.md#first-use-workflow). Execute the whole workflow manually against the intended environment. **Manual execution writes prices, estimates, and snapshots.** Inspect the responses, especially `Check purchases`, before enabling automation.
6. Review the schedule and workflow timezone, then publish/activate the coordinated workflow in your n8n version. Leave standalone drafts unpublished/inactive for manual use. Activation is an operator step; importing does not intentionally start recurring work. Configure an n8n error workflow/notifications separately if desired; these drafts fail visibly in execution history and send no notifications.

The configuration captures the Hong Kong date once at execution start and sends it as `as_of_date` to both purchase processing and snapshotting, keeping a run consistent across midnight. For a manual historical run, set `asOfDate` to `YYYY-MM-DD`, then clear it before enabling the schedule. Date/account overrides do not change the crawl range: historical price gaps require the crawler backfill API first.

## Ordering, failures, and recovery

The crawler returns HTTP 202 before its worker finishes. The coordinated and download drafts poll the returned `job_id` immediately, then wait 30 seconds between checks while it is `queued` or `running`. Only `succeeded` opens the success branch. `partial`, `failed`, unknown status, missing/mismatched job ID, or exhaustion of `maxPolls` throws an execution error. Sixty checks allow roughly 30 minutes of waiting, plus HTTP/retry time; this is a count bound, not a wall-clock deadline. A polling timeout does not cancel the crawler job. Inspect that existing job before restarting; a new workflow execution intentionally queues a new sync.

The enqueue request uses a workflow/execution-specific `Idempotency-Key`, stable across its HTTP retries. HTTP nodes make at most three attempts, five seconds apart, with 60-second download/poll and 300-second purchase/valuation request timeouts. HTTP errors stop downstream nodes after retries. Retries can also repeat an HTTP error caused by bad credentials or payloads; fix those settings rather than repeatedly rerunning. Purchase processing and valuation persistence support repeat requests, but this does not provide a global lock across workflows. A timed-out synchronous request may still be running on the server: inspect it before starting another execution.

Purchase processing estimates contributions; it does not confirm actual transactions or execute broker trades. `failed_events > 0` stops the pipeline. `waiting_events > 0` is expected when usable prices are unavailable: `Check purchases` preserves `waiting_details` and sets `needsReview: true`, then allows valuation to proceed. Review these executions; a successful workflow can still contain waiting purchases. Today's snapshot can therefore include holdings without those pending contributions.

Rebuild runs with no date bounds (and the optional account filter), consuming pending invalidations and recalculating stale saved dates before saving the requested snapshot. Snapshot results must report `COMPLETE` with zero unpriced funds, otherwise the workflow fails **after the snapshot has been saved**. Rebuild's HTTP success alone does not prove every rebuilt historical valuation is complete; inspect valuation history when resolving historical gaps. `COMPLETE` also does not guarantee that the provider published a new price today; the API can use older available prices. No trading-calendar or price-age gate is added here.

Daily purchase processing handles the selected date's month. If n8n misses the end of a month, run the purchase draft manually with that month's final date after checking/backfilling its prices, then run the valuation draft to rebuild stale history and snapshot today. A seven-day rolling sync does not fill longer outages. Use `/v1/crawl/jobs/backfill` explicitly, wait for success, then recover purchases and valuations. Confirm actual purchases separately through the dashboard/API.

## Offline validation

Run from the repository root:

```bash
node --test src/n8n/workflows.test.cjs
```

The checks parse all exports, validate connections and safety settings, and simulate their actual Code/If/expression paths using fixture HTTP responses, including bounded polling, retries' stable idempotency expression, and downstream failure gates. They do not emulate n8n's import engine, credential binding, scheduler, persistence, or HTTP retries. Complete the manual import/run checks above before activation.

Upstream references: [import/export](https://docs.n8n.io/workflows/export-import/), [Schedule Trigger and timezone](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/), [HTTP Request and credentials](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/), [Wait](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait/).
