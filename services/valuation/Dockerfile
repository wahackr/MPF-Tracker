FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY services/valuation/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY shared /app/shared
COPY services/__init__.py /app/services/__init__.py
COPY services/valuation /app/services/valuation

CMD ["uvicorn", "services.valuation.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
