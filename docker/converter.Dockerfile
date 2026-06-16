FROM python:3.12-slim
WORKDIR /app

# weasyprint requires Pango/Cairo/GDK-Pixbuf and font support at runtime.
# build-essential is NOT needed — weasyprint ships pre-built wheels for linux/amd64.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libgdk-pixbuf-2.0-0 \
        libcairo2 \
        libffi-dev \
        shared-mime-info \
        fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY converter/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY converter/app.py ./app.py
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
