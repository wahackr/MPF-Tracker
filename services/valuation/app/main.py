from shared.app_factory import create_service_app
from shared.job_worker import JobWorker
from shared.settings import get_settings

from services.valuation.app.jobs import build_job_handlers
from services.valuation.app.routes import router

worker = JobWorker(service="valuation", handlers=build_job_handlers())
settings = get_settings()

on_startup = [worker.start] if settings.enable_job_worker else None
on_shutdown = [worker.stop] if settings.enable_job_worker else None

app = create_service_app(
    service_name="valuation",
    on_startup=on_startup,
    on_shutdown=on_shutdown,
)
app.include_router(router)
