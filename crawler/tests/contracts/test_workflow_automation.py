import json
from pathlib import Path


WORKFLOWS = Path(__file__).resolve().parents[3] / "n8n" / "workflows"


def test_daily_crawl_waits_for_terminal_result() -> None:
    workflow = json.loads((WORKFLOWS / "MPF-01-Daily-Prices.json").read_text())
    nodes = {node["name"]: node for node in workflow["nodes"]}
    assert nodes["Get crawler status"]["parameters"]["method"] == "GET"
    assert "job_id" in nodes["Get crawler status"]["parameters"]["url"]
    assert workflow["connections"]["Poll again?"]["main"][0][0]["node"] == "Wait 30 seconds"
    assert workflow["connections"]["Crawler succeeded?"]["main"][1][0]["node"] == "Report crawler failure"


def test_broad_history_backfill_is_manual() -> None:
    workflow = json.loads((WORKFLOWS / "MPF-02-Manual-Backfill.json").read_text())
    assert workflow["nodes"][0]["type"] == "n8n-nodes-base.manualTrigger"
    assert all(node["type"] != "n8n-nodes-base.scheduleTrigger" for node in workflow["nodes"])
    assert 'provider:\'hsbc\'' in workflow["nodes"][1]["parameters"]["jsonBody"]
