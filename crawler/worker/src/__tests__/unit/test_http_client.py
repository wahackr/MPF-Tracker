from __future__ import annotations

from pathlib import Path
import sys

import httpx
import pytest


WORKER_SRC_DIR = Path(__file__).resolve().parents[2]
if str(WORKER_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC_DIR))

from libs import http_client


class FakeHttpClient:
    def __init__(
        self,
        responses: list[httpx.Response],
        calls: list[dict[str, object]],
    ) -> None:
        self.responses = responses
        self.calls = calls

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False

    def request(self, **kwargs: object) -> httpx.Response:
        self.calls.append(kwargs)
        return self.responses.pop(0)


def test_retry_succeeds_after_transient_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://provider.example/funds"
    responses = [
        httpx.Response(503, request=httpx.Request("GET", url), text="busy"),
        httpx.Response(200, request=httpx.Request("GET", url), text="ok"),
    ]
    calls: list[dict[str, object]] = []
    sleeps: list[float] = []
    monkeypatch.setattr(
        http_client.httpx,
        "Client",
        lambda **_kwargs: FakeHttpClient(responses, calls),
    )
    monkeypatch.setattr(http_client.time, "sleep", sleeps.append)

    response = http_client.request_with_retry(
        timeout_seconds=30.0,
        retries=3,
        backoff_seconds=0.25,
        method="GET",
        url=url,
        params={"provider": "test"},
        headers={"Accept": "application/json"},
    )

    assert response.text == "ok"
    assert len(calls) == 2
    assert sleeps == [0.25]


def test_retry_exhaustion_raises_provider_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://provider.example/funds"
    responses = [
        httpx.Response(503, request=httpx.Request("GET", url), text="busy")
        for _ in range(3)
    ]
    calls: list[dict[str, object]] = []
    sleeps: list[float] = []
    monkeypatch.setattr(
        http_client.httpx,
        "Client",
        lambda **_kwargs: FakeHttpClient(responses, calls),
    )
    monkeypatch.setattr(http_client.time, "sleep", sleeps.append)

    with pytest.raises(http_client.ProviderHttpError, match="Request failed after retries"):
        http_client.request_with_retry(
            timeout_seconds=30.0,
            retries=3,
            backoff_seconds=0.1,
            method="GET",
            url=url,
            params={},
            headers={},
        )

    assert len(calls) == 3
    assert sleeps == [0.1, 0.2]
