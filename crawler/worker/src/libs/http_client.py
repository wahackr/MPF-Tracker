from __future__ import annotations

import time
from pathlib import Path
from typing import Any, TypedDict

import httpx


class ProviderHttpError(RuntimeError):
    pass


class FetchResult(TypedDict):
    source: str
    payload: str
    status_code: int
    fetched_at: str


def request_with_retry(
    *,
    timeout_seconds: float,
    retries: int,
    backoff_seconds: float,
    method: str,
    url: str,
    params: dict[str, Any],
    headers: dict[str, str],
) -> httpx.Response:
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            with httpx.Client(timeout=timeout_seconds, follow_redirects=True, http2=True) as client:
                response = client.request(method=method, url=url, params=params, headers=headers)
            if response.status_code in (429, 500, 502, 503, 504):
                raise ProviderHttpError(f"HTTP {response.status_code} from {url} (attempt {attempt}/{retries})")
            response.raise_for_status()
            return response
        except (httpx.RequestError, httpx.HTTPStatusError, ProviderHttpError) as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(backoff_seconds * attempt)
    raise ProviderHttpError(f"Request failed after retries: {method} {url}: {last_error}")


def read_fixture(*, fixture_dir: Path | None, filename: str, required: bool = True) -> str | None:
    if not fixture_dir:
        if required:
            raise ProviderHttpError("Fixture mode enabled but fixture_dir is not configured")
        return None
    file_path = fixture_dir / filename
    if not file_path.exists():
        if required:
            raise ProviderHttpError(f"Fixture not found: {file_path}")
        return None
    return file_path.read_text(encoding="utf-8")
