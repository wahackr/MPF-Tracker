from collections.abc import Callable
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException

from shared.db import ping_database
from shared.models import HealthResponse
from shared.settings import get_settings


def create_service_app(
    *,
    service_name: str,
    on_startup: list[Callable[[], None]] | None = None,
    on_shutdown: list[Callable[[], None]] | None = None,
) -> FastAPI:
    app = FastAPI(
        title=f"mpf-{service_name}",
        version="0.1.0",
    )

    if on_startup:
        for hook in on_startup:
            app.add_event_handler("startup", hook)
    if on_shutdown:
        for hook in on_shutdown:
            app.add_event_handler("shutdown", hook)

    @app.get("/health", response_model=HealthResponse, tags=["system"])
    def health() -> HealthResponse:
        settings = get_settings()
        db_ok = ping_database()
        if db_ok:
            return HealthResponse(
                service=service_name,
                status="ready",
                database="up",
                checked_at=datetime.now(timezone.utc),
            )
        if settings.health_db_required:
            raise HTTPException(
                status_code=503,
                detail={
                    "service": service_name,
                    "status": "not_ready",
                    "database": "down",
                },
            )
        return HealthResponse(
            service=service_name,
            status="degraded",
            database="down",
            checked_at=datetime.now(timezone.utc),
        )

    return app
