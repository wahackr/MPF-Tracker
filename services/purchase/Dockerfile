FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY services/purchase/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY shared /app/shared
COPY services/__init__.py /app/services/__init__.py
COPY services/purchase /app/services/purchase

CMD ["uvicorn", "services.purchase.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
