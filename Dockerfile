FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server ./server
COPY web ./web
COPY samples ./samples
RUN python -m server.build
EXPOSE 8000
CMD ["uvicorn", "server.api:app", "--host", "0.0.0.0", "--port", "8000"]
