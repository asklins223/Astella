FROM python:3.11-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/data/hf \
    TRANSFORMERS_CACHE=/data/hf \
    SENTENCE_TRANSFORMERS_HOME=/data/hf

# CPU-only torch on both architectures. The default PyPI wheel pulls the CUDA
# stack (3.3 GB of nvidia-* packages) even on arm64, which made this image 9.6 GB.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
 && pip install --no-cache-dir fastapi uvicorn sentence-transformers

COPY infra/embedding/server.py /app/server.py
EXPOSE 80
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "80"]
