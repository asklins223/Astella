"""Local BGE-M3 embedding server (OpenAI-compatible /v1/embeddings).

The worker's SiliconFlow provider truncates inputs at 1500 characters. Keep the
same contract here so a fallback produces comparable vectors for the same text.

The model loads in a background thread rather than at import time. On a cold
host the weights may still be downloading; blocking the event loop there makes
/health unreachable and the container looks dead while it is actually working.
Until the model is ready, /health reports 503 and /v1/embeddings reports 503,
so the worker's circuit keeps the primary provider in charge instead of
silently producing empty vectors.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import List, Optional, Union

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.environ.get("EMBEDDING_MODEL", "BAAI/bge-m3")
DEVICE = os.environ.get("EMBEDDING_DEVICE", "cpu")
MAX_CHARS = int(os.environ.get("EMBEDDING_MAX_CHARS", "1500"))
BATCH_SIZE = int(os.environ.get("EMBEDDING_BATCH_SIZE", "8"))

logger = logging.getLogger("embedding")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Astella local embeddings")
_model: Optional[SentenceTransformer] = None
_load_error: Optional[str] = None
_ready = threading.Event()


def _load() -> None:
    global _model, _load_error
    try:
        logger.info("loading embedding model %s on %s", MODEL_NAME, DEVICE)
        _model = SentenceTransformer(MODEL_NAME, device=DEVICE)
        _ready.set()
        logger.info("embedding model ready")
    except Exception as error:  # noqa: BLE001 - surfaced through /health
        _load_error = f"{type(error).__name__}: {error}"
        logger.exception("embedding model failed to load")


threading.Thread(target=_load, name="model-load", daemon=True).start()


class EmbeddingRequest(BaseModel):
    model: str | None = None
    input: Union[str, List[str]]
    encoding_format: str | None = None


def _texts(value: Union[str, List[str]]) -> List[str]:
    items = [value] if isinstance(value, str) else value
    return [str(item)[:MAX_CHARS] for item in items]


@app.get("/health")
def health() -> dict:
    if _load_error:
        raise HTTPException(status_code=503, detail={"status": "error", "error": _load_error})
    if not _ready.is_set():
        raise HTTPException(status_code=503, detail={"status": "loading", "model": MODEL_NAME})
    return {"status": "ok", "model": MODEL_NAME, "device": DEVICE}


@app.post("/v1/embeddings")
def embeddings(request: EmbeddingRequest) -> dict:
    if not _ready.is_set() or _model is None:
        raise HTTPException(status_code=503, detail={"status": "loading", "model": MODEL_NAME})
    vectors = _model.encode(
        _texts(request.input),
        normalize_embeddings=True,
        batch_size=BATCH_SIZE,
        show_progress_bar=False,
    )
    data = [
        {"object": "embedding", "index": index, "embedding": vector.tolist()}
        for index, vector in enumerate(vectors)
    ]
    return {
        "object": "list",
        "model": request.model or MODEL_NAME,
        "data": data,
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    }
