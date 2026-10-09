from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from shared.app_factory import create_service_app
from services.crawler.app.routes import router as crawler_router
from services.portfolio.app.routes import router as portfolio_router
from services.purchase.app.routes import router as purchase_router
from services.valuation.app.routes import router as valuation_router


def _build_service_app(service_name: str, router: APIRouter) -> FastAPI:
    app = create_service_app(service_name=service_name)
    app.include_router(router)
    return app


def test_health_endpoint_available_for_all_services(monkeypatch) -> None:
    monkeypatch.setattr("shared.app_factory.ping_database", lambda: True)

    service_apps = (
        _build_service_app("crawler", crawler_router),
        _build_service_app("portfolio", portfolio_router),
        _build_service_app("purchase", purchase_router),
        _build_service_app("valuation", valuation_router),
    )
    for app in service_apps:
        with TestClient(app) as client:
            response = client.get("/health")
            assert response.status_code == 200
            payload = response.json()
            assert payload["status"] == "ready"
            assert payload["database"] == "up"


def test_auth_required_on_private_routes() -> None:
    test_cases = (
        (_build_service_app("crawler", crawler_router), "/v1/funds"),
        (_build_service_app("portfolio", portfolio_router), "/v1/accounts"),
        (_build_service_app("purchase", purchase_router), "/v1/purchase/events"),
        (_build_service_app("valuation", valuation_router), "/v1/valuation/latest"),
    )

    for app, path in test_cases:
        with TestClient(app) as client:
            response = client.get(path)
            assert response.status_code == 401
            assert response.json()["detail"] == "Invalid or missing API key"
