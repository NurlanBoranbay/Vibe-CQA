FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    CQA_DB=/app/state/cqa.sqlite

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY cqa/ cqa/
COPY checklists/ checklists/
COPY data/ data/
COPY web/ web/
COPY docker/entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 8030
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8030/health', timeout=4)"
ENTRYPOINT ["/entrypoint.sh"]
