from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import httpx


class ProviderHttpError(RuntimeError):
    pass


@dataclass(frozen=True)
class HttpFetchResult:
    source: str
    payload: str
    status_code: int
    fetched_at: str


class CrawlerHttpClient:
    def __init__(
        self,
        *,
        timeout_seconds: float = 30.0,
        retries: int = 3,
        backoff_seconds: float = 1.0,
        use_fixtures: bool = False,
        fixture_dir: Path | None = None,
    ) -> None:
        self._timeout_seconds = timeout_seconds
        self._retries = retries
        self._backoff_seconds = backoff_seconds
        self._use_fixtures = use_fixtures
        self._fixture_dir = fixture_dir

    def fetch_hsbc_all_funds_csv(self, *, from_date: date, to_date: date) -> HttpFetchResult:
        if self._use_fixtures:
            payload = self._read_fixture("hsbc_all_supertrust_20260901_20261007.csv")
            return HttpFetchResult(
                source="hsbc.fixture",
                payload=payload,
                status_code=200,
                fetched_at="fixture",
            )
        params = {
            "schemeCodes": "HB",
            "fundPricePeriodFrom": from_date.isoformat(),
            "fundPricePeriodTo": to_date.isoformat(),
            "language": "en_US",
        }
        response = self._request_with_retry(
            method="GET",
            url=(
                "https://rbwm-api.hsbc.com.hk/"
                "wpb-gpbw-mmw-hk-hbap-pa-p-wpp-mpf-market-data-prod-proxy/v1/download-funds"
            ),
            params=params,
            headers={"Accept": "text/csv"},
        )
        return HttpFetchResult(
            source="hsbc.download-funds",
            payload=response.text,
            status_code=response.status_code,
            fetched_at=response.headers.get("date", ""),
        )

    def fetch_manulife_fundslist(self) -> HttpFetchResult:
        if self._use_fixtures:
            payload = self._read_fixture("manulife_fundslist.json")
            return HttpFetchResult(
                source="manulife.fixture.fundslist",
                payload=payload,
                status_code=200,
                fetched_at="fixture",
            )
        response = self._request_with_retry(
            method="GET",
            url="https://scmpf.manulife.com.hk/bin/funds/fundslist",
            params={"productLine": "mpf", "overrideLocale": "en_HK"},
            headers={"Accept": "application/json"},
        )
        return HttpFetchResult(
            source="manulife.fundslist",
            payload=response.text,
            status_code=response.status_code,
            fetched_at=response.headers.get("date", ""),
        )

    def fetch_manulife_fundhistory(self, *, fund_id: str) -> HttpFetchResult:
        if self._use_fixtures:
            filename = f"manulife_fundhistory_{fund_id}.json"
            payload = self._read_fixture(filename, required=False)
            if payload is None:
                raise ProviderHttpError(
                    f"Missing fixture: {filename}. Real API fixture still unverified/blocked."
                )
            return HttpFetchResult(
                source="manulife.fixture.fundhistory",
                payload=payload,
                status_code=200,
                fetched_at="fixture",
            )
        response = self._request_with_retry(
            method="GET",
            url="https://scmpf.manulife.com.hk/bin/funds/fundhistory",
            params={"id": fund_id, "productLine": "mpf", "overrideLocale": "en_HK"},
            headers={"Accept": "application/json,text/plain,*/*", "User-Agent": "Mozilla/5.0"},
        )
        return HttpFetchResult(
            source="manulife.fundhistory",
            payload=response.text,
            status_code=response.status_code,
            fetched_at=response.headers.get("date", ""),
        )

    def _request_with_retry(
        self,
        *,
        method: str,
        url: str,
        params: dict[str, Any],
        headers: dict[str, str],
    ) -> httpx.Response:
        last_error: Exception | None = None
        for attempt in range(1, self._retries + 1):
            try:
                with httpx.Client(timeout=self._timeout_seconds, follow_redirects=True) as client:
                    response = client.request(
                        method=method,
                        url=url,
                        params=params,
                        headers=headers,
                    )
                if response.status_code in (429, 500, 502, 503, 504):
                    raise ProviderHttpError(
                        f"HTTP {response.status_code} from {url} (attempt {attempt}/{self._retries})"
                    )
                response.raise_for_status()
                return response
            except Exception as exc:
                last_error = exc
                if attempt < self._retries:
                    time.sleep(self._backoff_seconds * attempt)
        raise ProviderHttpError(f"Request failed after retries: {method} {url}: {last_error}")

    def _read_fixture(self, filename: str, *, required: bool = True) -> str | None:
        if not self._fixture_dir:
            if required:
                raise ProviderHttpError("Fixture mode enabled but fixture_dir is not configured")
            return None
        file_path = self._fixture_dir / filename
        if not file_path.exists():
            if required:
                raise ProviderHttpError(f"Fixture not found: {file_path}")
            return None
        return file_path.read_text(encoding="utf-8")
