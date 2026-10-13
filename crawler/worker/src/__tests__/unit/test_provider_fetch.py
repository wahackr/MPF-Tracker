from __future__ import annotations

from datetime import date
from pathlib import Path
import sys

import httpx
import pytest

REPO_ROOT = Path(__file__).resolve().parents[5]
WORKER_SRC_DIR = REPO_ROOT / "crawler" / "worker"
if str(WORKER_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC_DIR))

from src.libs.http_client import ProviderHttpError  # type: ignore[import-not-found]
from src.libs.crawlers.hsbc import fetch_all_funds_csv  # type: ignore[import-not-found]
from src.libs.crawlers.manulife import fetch_manulife_fundhistory, fetch_manulife_fundslist  # type: ignore[import-not-found]


FIXTURES_DIR = REPO_ROOT / "mpf-codex-handoff" / "fixtures"


class _FakeHttpClient:
    def __init__(self, responses: list[httpx.Response], calls: list[dict[str, object]]) -> None:
        self._responses = responses
        self._calls = calls

    def __enter__(self) -> _FakeHttpClient:
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False

    def request(self, **kwargs: object) -> httpx.Response:
        self._calls.append(kwargs)
        return self._responses.pop(0)


class _FakeHttpClientFactory:
    def __init__(self, responses: list[httpx.Response], calls: list[dict[str, object]]) -> None:
        self._responses = responses
        self._calls = calls

    def __call__(self, *args: object, **kwargs: object) -> _FakeHttpClient:
        return _FakeHttpClient(self._responses, self._calls)


def _fetch_options(
    *,
    retries: int = 3,
    backoff_seconds: float = 1.0,
):
    return {
        "timeout_seconds": 30.0,
        "retries": retries,
        "backoff_seconds": backoff_seconds,
    }


def test_mocked_http_response_reads_real_hsbc_csv(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = (FIXTURES_DIR / "hsbc_all_supertrust_20260901_20261007.csv").read_text(encoding="utf-8")

    def fake_request(_client, method, url, **_kwargs):
        return httpx.Response(200, request=httpx.Request(method, url), text=payload)

    monkeypatch.setattr(httpx.Client, "request", fake_request)
    result = fetch_all_funds_csv(from_date=date(2026, 9, 1), to_date=date(2026, 10, 7), **_fetch_options())
    assert result["source"] == "hsbc.download-funds"
    assert result["status_code"] == 200
    assert "Constituent Fund" in result["payload"]


def test_mocked_http_response_reads_real_manulife_fundslist_json(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = (FIXTURES_DIR / "manulife_fundslist.json").read_text(encoding="utf-8")

    def fake_request(_client, method, url, **_kwargs):
        return httpx.Response(200, request=httpx.Request(method, url), text=payload)

    monkeypatch.setattr(httpx.Client, "request", fake_request)
    result = fetch_manulife_fundslist(**_fetch_options())
    assert result["source"] == "manulife.fundslist"
    assert result["status_code"] == 200
    assert '"fundId"' in result["payload"]


def test_hsbc_fetch_success_uses_expected_request_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    url = (
        "https://rbwm-api.hsbc.com.hk/"
        "wpb-gpbw-mmw-hk-hbap-pa-p-wpp-mpf-market-data-prod-proxy/v1/download-funds"
    )
    responses = [
        httpx.Response(200, request=httpx.Request("GET", url), text="csv-data", headers={"date": "Mon"}),
    ]
    calls: list[dict[str, object]] = []

    from src.libs import http_client as module  # type: ignore[import-not-found]

    monkeypatch.setattr(module.httpx, "Client", _FakeHttpClientFactory(responses, calls))

    options = _fetch_options()
    result = fetch_all_funds_csv(from_date=date(2026, 10, 1), to_date=date(2026, 10, 7), **options)

    assert result == {
        "source": "hsbc.download-funds",
        "payload": "csv-data",
        "status_code": 200,
        "fetched_at": "Mon",
    }
    assert len(calls) == 1
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == url
    assert calls[0]["params"] == {
        "schemeCodes": "HB",
        "fundPricePeriodFrom": "2026-10-01",
        "fundPricePeriodTo": "2026-10-07",
        "language": "en_US",
    }
    assert calls[0]["headers"] == {"Accept": "*/*"}


def test_manulife_fundslist_fetch_success_uses_expected_request_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://scmpf.manulife.com.hk/bin/funds/fundslist"
    responses = [
        httpx.Response(200, request=httpx.Request("GET", url), text='{"items":[]}', headers={"date": "Tue"}),
    ]
    calls: list[dict[str, object]] = []

    from src.libs import http_client as module  # type: ignore[import-not-found]

    monkeypatch.setattr(module.httpx, "Client", _FakeHttpClientFactory(responses, calls))

    options = _fetch_options()
    result = fetch_manulife_fundslist(**options)

    assert result == {
        "source": "manulife.fundslist",
        "payload": '{"items":[]}',
        "status_code": 200,
        "fetched_at": "Tue",
    }
    assert len(calls) == 1
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == url
    assert calls[0]["params"] == {"productLine": "mpf", "overrideLocale": "en_HK"}
    assert calls[0]["headers"] == {
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/154.0.0.0 Safari/537.36"
        ),
    }


def test_manulife_fundhistory_fetch_success_uses_expected_request_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://scmpf.manulife.com.hk/bin/funds/fundhistory"
    responses = [
        httpx.Response(200, request=httpx.Request("GET", url), text='{"history":[]}', headers={"date": "Wed"}),
    ]
    calls: list[dict[str, object]] = []

    from src.libs import http_client as module  # type: ignore[import-not-found]

    monkeypatch.setattr(module.httpx, "Client", _FakeHttpClientFactory(responses, calls))

    options = _fetch_options()
    result = fetch_manulife_fundhistory(fund_id="SHK122", **options)

    assert result == {
        "source": "manulife.fundhistory",
        "payload": '{"history":[]}',
        "status_code": 200,
        "fetched_at": "Wed",
    }
    assert len(calls) == 1
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == url
    assert calls[0]["params"] == {"id": "SHK122", "productLine": "mpf", "overrideLocale": "en_HK"}
    assert calls[0]["headers"] == {
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/154.0.0.0 Safari/537.36"
        ),
    }


def test_retry_succeeds_after_transient_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    url = "https://scmpf.manulife.com.hk/bin/funds/fundslist"
    responses = [
        httpx.Response(503, request=httpx.Request("GET", url), text="busy"),
        httpx.Response(200, request=httpx.Request("GET", url), text='{"ok":true}', headers={"date": "Tue"}),
    ]
    calls: list[dict[str, object]] = []
    sleeps: list[float] = []

    from src.libs import http_client as module  # type: ignore[import-not-found]

    monkeypatch.setattr(module.httpx, "Client", _FakeHttpClientFactory(responses, calls))
    monkeypatch.setattr(module.time, "sleep", lambda seconds: sleeps.append(seconds))

    options = _fetch_options(retries=3, backoff_seconds=0.25)
    result = fetch_manulife_fundslist(**options)

    assert result["source"] == "manulife.fundslist"
    assert result["payload"] == '{"ok":true}'
    assert len(calls) == 2
    assert sleeps == [0.25]
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == url
    assert calls[0]["params"] == {"productLine": "mpf", "overrideLocale": "en_HK"}
    assert calls[0]["headers"] == {
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/154.0.0.0 Safari/537.36"
        ),
    }


def test_retry_exhaustion_raises_provider_error(monkeypatch: pytest.MonkeyPatch) -> None:
    url = (
        "https://rbwm-api.hsbc.com.hk/"
        "wpb-gpbw-mmw-hk-hbap-pa-p-wpp-mpf-market-data-prod-proxy/v1/download-funds"
    )
    responses = [
        httpx.Response(503, request=httpx.Request("GET", url), text="busy"),
        httpx.Response(503, request=httpx.Request("GET", url), text="busy"),
        httpx.Response(503, request=httpx.Request("GET", url), text="busy"),
    ]
    calls: list[dict[str, object]] = []
    sleeps: list[float] = []

    from src.libs import http_client as module  # type: ignore[import-not-found]

    monkeypatch.setattr(module.httpx, "Client", _FakeHttpClientFactory(responses, calls))
    monkeypatch.setattr(module.time, "sleep", lambda seconds: sleeps.append(seconds))

    options = _fetch_options(retries=3, backoff_seconds=0.1)
    with pytest.raises(ProviderHttpError, match="Request failed after retries"):
        fetch_all_funds_csv(from_date=date(2026, 10, 1), to_date=date(2026, 10, 7), **options)

    assert len(calls) == 3
    assert sleeps == [0.1, 0.2]
    assert calls[0]["headers"] == {"Accept": "*/*"}
