# XAI Chat — faster responses (tokens + streaming)

## What improved speed

| Technique | Effect |
|-----------|--------|
| **Token streaming (SSE)** | First words appear in ~0.5s instead of waiting for the full answer |
| **`max_output_tokens`** | Caps length (default 512) so generation finishes sooner |
| **Trimmed history** | Only last 6 turns sent → smaller/faster prompts |
| **Lower temperature** | Slightly more focused, often quicker |
| **`gemini-1.5-flash`** | Fast model tier |

## Run

```bash
cd xai-chat/backend   # or "xai-chat 2/backend" if macOS renamed the folder
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Open **http://127.0.0.1:8000**

### Enable live Gemini

Edit `backend/.env`:

```env
XAI_FORCE_MOCK=0
GEMINI_API_KEY=your_key_here
MAX_OUTPUT_TOKENS=512
```

Restart uvicorn. Health check: http://127.0.0.1:8000/health  
Should show `"streaming": true, "mode": "gemini"`.

### Make it even faster

In `.env` try:

```env
MAX_OUTPUT_TOKENS=256
MAX_HISTORY_TURNS=4
TEMPERATURE=0.3
```

## Folder name note

If macOS extracted the zip as **`xai-chat 2`**, use:

```bash
cd ~/Downloads/xai-chat\ 2/backend
```
