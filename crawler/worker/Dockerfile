FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY crawler/worker/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY crawler/worker/src /app/crawler_worker
COPY mpf-codex-handoff/fixtures /app/mpf-codex-handoff/fixtures

CMD ["python", "-m", "crawler_worker.app"]
