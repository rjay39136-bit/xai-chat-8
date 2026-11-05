"""
XAI FastAPI backend — fast chat via:
  • Token streaming (SSE) so the UI shows text as it is generated
  • max_output_tokens + temperature limits (shorter = faster)
  • Trimmed history (last N turns only)
  • Instant mock mode when no API key / XAI_FORCE_MOCK=1
"""

from __future__ import annotations

import asyncio
import json
import os
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, AsyncIterator, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

# ---------------------------------------------------------------------------
# Speed / generation knobs (override in .env)
# ---------------------------------------------------------------------------
MAX_OUTPUT_TOKENS = int(os.getenv("MAX_OUTPUT_TOKENS", "2048"))   # shorter → faster
TEMPERATURE = float(os.getenv("TEMPERATURE", "0.4"))
TOP_P = float(os.getenv("TOP_P", "0.9"))
MAX_HISTORY_TURNS = int(os.getenv("MAX_HISTORY_TURNS", "6"))    # last N user+model pairs
GEMINI_TIMEOUT = float(os.getenv("GEMINI_TIMEOUT", "45"))
WEB_SEARCH_ENABLED = os.getenv("WEB_SEARCH", "1").strip().lower() in {"1", "true", "yes"}
WEB_SEARCH_RESULTS = int(os.getenv("WEB_SEARCH_RESULTS", "5"))

# Prefer env override; otherwise try modern Flash models in order (1.5 is often 404 now)
GEMINI_MODEL_NAME = os.getenv("GEMINI_MODEL", "").strip()
MODEL_CANDIDATES = [
    GEMINI_MODEL_NAME,
    # Current models for new API keys (Oct 2026+)
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-flash-latest",
]
# de-dupe while keeping order
_seen = set()
MODEL_CANDIDATES = [m for m in MODEL_CANDIDATES if m and not (m in _seen or _seen.add(m))]

app = FastAPI(title="XAI Backend", version="2.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Gemini client — pick first model that accepts a tiny generateContent call
# ---------------------------------------------------------------------------
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
FORCE_MOCK = os.getenv("XAI_FORCE_MOCK", "").strip().lower() in {"1", "true", "yes"}
model = None
gen_config = None
ACTIVE_MODEL_NAME = None


def _init_gemini():
    """Pick a model quickly. Do NOT probe dozens of listed models (that caused long hangs)."""
    global model, gen_config, ACTIVE_MODEL_NAME
    import google.generativeai as genai
    from google.generativeai.types import GenerationConfig

    genai.configure(api_key=GEMINI_API_KEY)
    gen_config = GenerationConfig(
        max_output_tokens=MAX_OUTPUT_TOKENS,
        temperature=TEMPERATURE,
        top_p=TOP_P,
    )

    # If user set GEMINI_MODEL, use it immediately (no multi-model probe).
    preferred = (GEMINI_MODEL_NAME or "").strip()
    ordered = []
    if preferred:
        ordered.append(preferred)
    for c in MODEL_CANDIDATES:
        if c and c not in ordered:
            ordered.append(c)

    # Cap attempts — probing every listed model was freezing startup / first request
    ordered = ordered[:5]
    print(f"[XAI] Trying models (fast path): {ordered}")

    last_err = None
    for name in ordered:
        try:
            candidate = genai.GenerativeModel(name, generation_config=gen_config)
            # Skip network probe when user explicitly set the model — trust .env
            if preferred and name == preferred:
                model = candidate
                ACTIVE_MODEL_NAME = name
                print(
                    f"[XAI] Gemini ready model={name} (from .env) "
                    f"max_tokens={MAX_OUTPUT_TOKENS}"
                )
                return

            probe = candidate.generate_content(
                "ok",
                generation_config=GenerationConfig(max_output_tokens=4, temperature=0),
            )
            _ = getattr(probe, "text", None)
            model = candidate
            ACTIVE_MODEL_NAME = name
            print(
                f"[XAI] Gemini ready model={name} "
                f"max_tokens={MAX_OUTPUT_TOKENS} temp={TEMPERATURE}"
            )
            return
        except Exception as e:
            last_err = e
            print(f"[XAI] model {name!r} unavailable: {e}")
            continue

    raise RuntimeError(f"No usable Gemini model. Last error: {last_err}")


if FORCE_MOCK:
    print("[XAI] XAI_FORCE_MOCK=1 — mock mode (instant)")
elif GEMINI_API_KEY:
    try:
        _init_gemini()
    except Exception as e:
        print(f"[XAI] Gemini init failed: {e}")
        model = None
else:
    print("[XAI] No GEMINI_API_KEY — mock mode")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class HistoryMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    chat_id: str = ""
    message: str
    history: List[HistoryMessage] = Field(default_factory=list)
    web_search: Optional[bool] = None  # None = use server default WEB_SEARCH


class SourceLink(BaseModel):
    title: str = ""
    url: str = ""
    snippet: str = ""


class ChatResponse(BaseModel):
    answer: str
    sources: List[SourceLink] = Field(default_factory=list)


class CombineRequest(BaseModel):
    chat_a: List[HistoryMessage]
    chat_b: List[HistoryMessage]


class CombineResponse(BaseModel):
    analysis: str


class HealthResponse(BaseModel):
    status: str
    mode: str
    max_output_tokens: int
    streaming: bool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _trim_history(history: List[HistoryMessage]) -> List[HistoryMessage]:
    """Keep only the last MAX_HISTORY_TURNS*2 messages (user+assistant pairs)."""
    limit = max(2, MAX_HISTORY_TURNS * 2)
    if len(history) <= limit:
        return history
    return history[-limit:]


def _mock_answer(user_message: str, context: str = "") -> str:
    preview = (user_message or "").strip()[:160]
    extra = f"\n\n({context})" if context else ""
    return (
        f"[Mock — set GEMINI_API_KEY and XAI_FORCE_MOCK=0 for live answers]\n\n"
        f"You asked: “{preview}”\n\n"
        "1. Clarify the question\n"
        "2. Key concepts\n"
        "3. Short example\n"
        "4. Takeaway"
        f"{extra}"
    )



def _web_search(query: str, max_results: int = 5) -> List[dict]:
    """Web search via ddgs (DuckDuckGo). No API key required."""
    if not query.strip():
        return []
    rows: List[dict] = []

    def _normalize(item: dict) -> dict:
        return {
            "title": (item.get("title") or "").strip(),
            "url": (item.get("href") or item.get("link") or item.get("url") or "").strip(),
            "snippet": (item.get("body") or item.get("snippet") or item.get("description") or "").strip(),
        }

    # Preferred package name (duckduckgo_search was renamed)
    try:
        try:
            from ddgs import DDGS  # type: ignore
        except ImportError:
            from duckduckgo_search import DDGS  # type: ignore

        # Newer ddgs API: no context manager required on some versions
        try:
            client = DDGS()
            results = list(client.text(query, max_results=max_results))
        except TypeError:
            with DDGS() as client:
                results = list(client.text(query, max_results=max_results))

        for item in results or []:
            row = _normalize(item if isinstance(item, dict) else {})
            if row.get("url"):
                rows.append(row)
        if rows:
            return rows[:max_results]
        print("[XAI] ddgs returned 0 rows — trying HTML lite fallback")
    except Exception as e:
        print(f"[XAI] ddgs search failed: {e}")
        traceback.print_exc()

    # Lightweight fallback: DuckDuckGo lite HTML (no extra keys)
    try:
        import re
        import urllib.parse
        import urllib.request

        q = urllib.parse.quote_plus(query)
        url = f"https://lite.duckduckgo.com/lite/?q={q}"
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; XAI-Bot/1.0)"},
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            html = resp.read().decode("utf-8", errors="ignore")

        # Links look like: <a rel="nofollow" href="https://...">Title</a>
        pattern = re.compile(
            r'<a[^>]+rel="nofollow"[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>',
            re.I | re.S,
        )
        seen = set()
        for href, title in pattern.findall(html):
            if "duckduckgo.com" in href:
                continue
            title = re.sub(r"<[^>]+>", "", title).strip()
            if not href or href in seen:
                continue
            seen.add(href)
            rows.append({"title": title or href, "url": href, "snippet": ""})
            if len(rows) >= max_results:
                break
        return rows
    except Exception as e:
        print(f"[XAI] HTML search fallback failed: {e}")
        return []


def _build_prompt_with_sources(user_message: str, sources: List[dict]) -> str:
    """Augment the user question with search snippets and require link citations."""
    if not sources:
        return (
            "Answer clearly and concisely for a general audience.\n\n"
            f"User question: {user_message}"
        )
    lines = []
    for i, s in enumerate(sources, 1):
        lines.append(
            f"[{i}] {s.get('title') or 'Source'}\n"
            f"URL: {s.get('url')}\n"
            f"Snippet: {(s.get('snippet') or '')[:280]}"
        )
    block = "\n\n".join(lines)
    return (
        "You are a helpful research assistant. Use the web search results below when relevant.\n"
        "Rules:\n"
        "- Write a clear, structured answer for a general audience.\n"
        "- Prefer facts supported by the sources.\n"
        "- Cite sources inline like [1], [2] where appropriate.\n"
        "- End with a short 'Sources' section listing the numbers and full URLs you used.\n"
        "- If sources are weak or unrelated, say so and answer from general knowledge.\n\n"
        f"Web search results:\n{block}\n\n"
        f"User question: {user_message}"
    )


def _should_search(req_flag: Optional[bool]) -> bool:
    if req_flag is None:
        return WEB_SEARCH_ENABLED
    return bool(req_flag)


def _history_to_gemini(history: List[HistoryMessage]) -> list:
    out = []
    for m in history:
        role = "user" if m.role == "user" else "model"
        out.append({"role": role, "parts": [m.content]})
    return out


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _stream_gemini_sync(prompt: str, history: Optional[List[HistoryMessage]]):
    """Yield text chunks from Gemini streaming API (blocking generator)."""
    hist = _trim_history(history or [])
    if hist:
        chat = model.start_chat(history=_history_to_gemini(hist))
        stream = chat.send_message(prompt, stream=True)
    else:
        stream = model.generate_content(prompt, stream=True)
    for chunk in stream:
        try:
            t = chunk.text
        except Exception:
            t = ""
        if t:
            yield t


async def _stream_tokens(
    prompt: str, history: Optional[List[HistoryMessage]] = None
) -> AsyncIterator[str]:
    """Async SSE body: token chunks, then done. Never hangs the client forever."""
    if model is None:
        text = _mock_answer(prompt)
        step = max(8, len(text) // 24)
        for i in range(0, len(text), step):
            yield _sse({"token": text[i : i + step]})
            await asyncio.sleep(0.015)
        yield _sse({"done": True})
        return

    loop = asyncio.get_event_loop()
    queue: asyncio.Queue = asyncio.Queue()
    first_token_timeout = min(15.0, GEMINI_TIMEOUT)  # fail fast if API is stuck

    def worker():
        try:
            for piece in _stream_gemini_sync(prompt, history):
                loop.call_soon_threadsafe(queue.put_nowait, ("token", piece))
            loop.call_soon_threadsafe(queue.put_nowait, ("done", None))
        except Exception as e:
            traceback.print_exc()
            loop.call_soon_threadsafe(queue.put_nowait, ("error", str(e)))

    executor = ThreadPoolExecutor(max_workers=1)
    executor.submit(worker)
    got_token = False

    try:
        while True:
            wait = first_token_timeout if not got_token else GEMINI_TIMEOUT
            try:
                kind, payload = await asyncio.wait_for(queue.get(), timeout=wait)
            except asyncio.TimeoutError:
                msg = (
                    f"Model did not respond within {wait:.0f}s. "
                    "Check network/API key, or set XAI_FORCE_MOCK=1 for instant replies."
                )
                print(f"[XAI] stream timeout: {msg}")
                if not got_token:
                    fallback = _mock_answer(prompt, context=msg)
                    yield _sse({"token": fallback})
                else:
                    yield _sse({"error": msg})
                yield _sse({"done": True})
                break

            if kind == "token":
                got_token = True
                yield _sse({"token": payload})
            elif kind == "error":
                fallback = _mock_answer(prompt, context=f"stream error: {payload}")
                yield _sse({"token": fallback})
                yield _sse({"done": True})
                break
            else:
                yield _sse({"done": True})
                break
    finally:
        executor.shutdown(wait=False)


def _call_gemini_full(prompt: str, history: Optional[List[HistoryMessage]] = None) -> str:
    """Non-streaming full response (upload / combine)."""
    if model is None:
        return _mock_answer(prompt)
    hist = _trim_history(history or [])
    if hist:
        chat = model.start_chat(history=_history_to_gemini(hist))
        response = chat.send_message(prompt)
    else:
        response = model.generate_content(prompt)
    return (getattr(response, "text", None) or str(response)).strip()


async def _generate_text(prompt: str, history: Optional[List[HistoryMessage]] = None) -> str:
    if model is None:
        return _mock_answer(prompt)
    loop = asyncio.get_event_loop()
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            return await asyncio.wait_for(
                loop.run_in_executor(pool, lambda: _call_gemini_full(prompt, history)),
                timeout=GEMINI_TIMEOUT,
            )
    except asyncio.TimeoutError:
        return _mock_answer(prompt, context=f"timeout after {GEMINI_TIMEOUT}s")
    except Exception as e:
        traceback.print_exc()
        return _mock_answer(prompt, context=str(e))


async def _generate_with_file(
    message: str, file_bytes: bytes, mime_type: str, filename: str
) -> str:
    if model is None:
        return _mock_answer(
            message,
            context=f"File: {filename} ({mime_type}, {len(file_bytes)} bytes)",
        )

    def _sync() -> str:
        if mime_type.startswith("image/"):
            parts: list[Any] = [
                {"mime_type": mime_type, "data": file_bytes},
                message or "Describe this image briefly and list key points.",
            ]
            response = model.generate_content(parts)
        else:
            try:
                text_content = file_bytes.decode("utf-8", errors="replace")
                if len(text_content) > 40_000:
                    text_content = text_content[:40_000] + "\n…[truncated]"
                prompt = (
                    f"File “{filename}” contents:\n```\n{text_content}\n```\n\n"
                    f"Question: {message or 'Summarize the important points concisely.'}"
                )
            except Exception:
                prompt = f"Binary file {filename} ({mime_type}). {message}"
            response = model.generate_content(prompt)
        return (getattr(response, "text", None) or str(response)).strip()

    loop = asyncio.get_event_loop()
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            return await asyncio.wait_for(
                loop.run_in_executor(pool, _sync),
                timeout=GEMINI_TIMEOUT,
            )
    except Exception as e:
        traceback.print_exc()
        return _mock_answer(message, context=str(e))


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        mode=("gemini:" + (ACTIVE_MODEL_NAME or "?")) if model is not None else "mock",
        max_output_tokens=MAX_OUTPUT_TOKENS,
        streaming=True,
    )


async def _prepare_prompt(req: ChatRequest) -> tuple[str, List[dict]]:
    """Optional DuckDuckGo search + prompt enrichment."""
    sources: List[dict] = []
    prompt = req.message
    if _should_search(req.web_search):
        print(f"[XAI] web search: {req.message[:80]!r}")
        loop = asyncio.get_event_loop()
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                sources = await asyncio.wait_for(
                    loop.run_in_executor(
                        pool, lambda: _web_search(req.message, WEB_SEARCH_RESULTS)
                    ),
                    timeout=8.0,  # never let search alone burn 30s
                )
        except asyncio.TimeoutError:
            print("[XAI] web search timed out after 8s — answering without sources")
            sources = []
        except Exception as e:
            print(f"[XAI] web search error: {e}")
            sources = []
        print(f"[XAI] web search got {len(sources)} results")
        prompt = _build_prompt_with_sources(req.message, sources)
    return prompt, sources


async def _stream_tokens_with_sources(
    prompt: str,
    history: Optional[List[HistoryMessage]],
    sources: List[dict],
) -> AsyncIterator[str]:
    async for chunk in _stream_tokens(prompt, history=history):
        yield chunk
    # After model tokens, always emit sources for the UI (even if empty)
    yield _sse({"sources": sources})


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    """Streaming chat — tokens + optional web sources as SSE."""
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="message is required")

    prompt, sources = await _prepare_prompt(req)
    print(
        f"[XAI] /chat/stream msg={req.message[:60]!r} "
        f"hist={len(req.history)} mode={'gemini' if model else 'mock'} "
        f"max_tokens={MAX_OUTPUT_TOKENS} sources={len(sources)}"
    )

    return StreamingResponse(
        _stream_tokens_with_sources(prompt, req.history, sources),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    """Non-streaming fallback (still uses max_output_tokens + optional web search)."""
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="message is required")
    prompt, sources = await _prepare_prompt(req)
    print(f"[XAI] /chat msg={req.message[:60]!r} mode={'gemini' if model else 'mock'} sources={len(sources)}")
    answer = await _generate_text(prompt, history=req.history)
    return ChatResponse(
        answer=answer,
        sources=[SourceLink(**s) for s in sources],
    )


@app.post("/upload", response_model=ChatResponse)
async def upload(
    file: UploadFile = File(...),
    message: str = Form("Analyze this file and explain the important points."),
    chat_id: str = Form(""),
) -> ChatResponse:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")
    mime = file.content_type or "application/octet-stream"
    answer = await _generate_with_file(message, raw, mime, file.filename or "upload")
    return ChatResponse(answer=answer)


@app.post("/combine-analyze", response_model=CombineResponse)
async def combine_analyze(req: CombineRequest) -> CombineResponse:
    def fmt(msgs: List[HistoryMessage]) -> str:
        lines = []
        for m in msgs[-8:]:
            lines.append(f"{m.role.upper()}: {m.content[:500]}")
        return "\n".join(lines) or "(empty)"

    prompt = (
        "Compare the two chats briefly (max ~200 words):\n"
        "- Main topics\n- Overlap / differences\n- One recommendation\n\n"
        f"=== A ===\n{fmt(req.chat_a)}\n\n=== B ===\n{fmt(req.chat_b)}\n"
    )
    analysis = await _generate_text(prompt)
    return CombineResponse(analysis=analysis)


# ---------------------------------------------------------------------------
# Frontend static files
# ---------------------------------------------------------------------------
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


@app.get("/")
def root():
    index = FRONTEND_DIR / "index.html"
    if index.is_file():
        return FileResponse(index)
    return {"service": "XAI Backend", "docs": "/docs", "health": "/health"}


if FRONTEND_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

    @app.get("/styles.css")
    def styles():
        return FileResponse(FRONTEND_DIR / "styles.css", media_type="text/css")

    @app.get("/script.js")
    def script():
        return FileResponse(FRONTEND_DIR / "script.js", media_type="application/javascript")

    @app.get("/favicon.svg")
    def favicon_svg():
        return FileResponse(FRONTEND_DIR / "favicon.svg", media_type="image/svg+xml")

    @app.get("/favicon.ico")
    def favicon_ico():
        return FileResponse(FRONTEND_DIR / "favicon.svg", media_type="image/svg+xml")
