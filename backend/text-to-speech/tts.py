import io
import os
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import torch
import torchaudio

load_dotenv()

STORAGE_PATH = Path(os.getenv("STORAGE_PATH", "./storage")).resolve()
DEVICE = os.getenv("DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
TTS_API_BASE_URL = os.getenv("TTS_API_BASE_URL", "http://localhost:8000")

STORAGE_PATH.mkdir(parents=True, exist_ok=True)
(STORAGE_PATH / "tts").mkdir(exist_ok=True)
(STORAGE_PATH / "voices").mkdir(exist_ok=True)

model_container: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"[STARTUP] Loading Chatterbox model on device: {DEVICE}...")
    try:
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        model_container["model"] = ChatterboxMultilingualTTS.from_pretrained(
            device=DEVICE
        )
        print("[STARTUP] Model loaded successfully. Sample rate:", model_container["model"].sr)
    except Exception as e:
        print(f"[STARTUP ERROR] Failed to load model: {e}", file=sys.stderr)
        raise
    yield
    print("[SHUTDOWN] Cleaning up...")
    model_container.clear()


app = FastAPI(
    title="AI Voice Studio - Local TTS API",
    description="Local Text-to-Speech backend using Chatterbox multilingual model with Arabic support",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TextToSpeechRequest(BaseModel):
    text: str
    voice_s3_key: Optional[str] = None
    voice_path: Optional[str] = None
    language: str = "en"
    exaggeration: float = 0.5
    cfg_weight: float = 0.5


class TextToSpeechResponse(BaseModel):
    s3_Key: str
    audio_url: str


class UploadVoiceResponse(BaseModel):
    file_path: str
    url: str
    file_name: str


app.mount("/audio", StaticFiles(directory=str(STORAGE_PATH)), name="audio")


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "device": DEVICE,
        "model_loaded": "model" in model_container,
        "storage_path": str(STORAGE_PATH),
        "supported_languages": [
            {"code": "en", "name": "English"},
            {"code": "ar", "name": "Arabic / العربية"},
            {"code": "es", "name": "Spanish"},
            {"code": "fr", "name": "French"},
            {"code": "de", "name": "German"},
            {"code": "it", "name": "Italian"},
            {"code": "pt", "name": "Portuguese"},
            {"code": "ru", "name": "Russian"},
            {"code": "zh", "name": "Chinese"},
            {"code": "ja", "name": "Japanese"},
            {"code": "ko", "name": "Korean"},
            {"code": "hi", "name": "Hindi"},
        ],
    }


@app.post("/generate-speech", response_model=TextToSpeechResponse)
async def generate_speech(request: TextToSpeechRequest):
    if "model" not in model_container:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    model = model_container["model"]

    if not request.text or not request.text.strip():
        raise HTTPException(status_code=400, detail="Text is required")

    voice_ref = request.voice_path or request.voice_s3_key

    audio_prompt_path: Optional[str] = None
    if voice_ref:
        candidate = Path(voice_ref)
        if not candidate.is_absolute():
            candidate = STORAGE_PATH / candidate
        if candidate.exists() and candidate.is_file():
            audio_prompt_path = str(candidate)
        else:
            alt = STORAGE_PATH / "voices" / Path(voice_ref).name
            if alt.exists() and alt.is_file():
                audio_prompt_path = str(alt)
            else:
                raise HTTPException(
                    status_code=404,
                    detail=f"Prompt audio not found. Tried: {candidate} and {alt}",
                )

    language_id = request.language.strip()

    try:
        with torch.no_grad():
            if audio_prompt_path:
                print(f"[GENERATE] Using voice prompt: {audio_prompt_path}")
                wav = model.generate(
                    request.text,
                    audio_prompt_path=audio_prompt_path,
                    language_id=language_id,
                    exaggeration=request.exaggeration,
                    cfg_weight=request.cfg_weight,
                )
            else:
                print(f"[GENERATE] Generating with language_id={language_id}")
                wav = model.generate(
                    request.text,
                    language_id=language_id,
                    exaggeration=request.exaggeration,
                    cfg_weight=request.cfg_weight,
                )
            wav_cpu = wav.cpu()

        buffer = io.BytesIO()
        torchaudio.save(buffer, wav_cpu, model.sr, format="wav")
        buffer.seek(0)
        audio_bytes = buffer.read()

        audio_uuid = str(uuid.uuid4())
        relative_key = f"tts/{audio_uuid}.wav"
        s3_path = STORAGE_PATH / relative_key
        s3_path.parent.mkdir(parents=True, exist_ok=True)
        with open(s3_path, "wb") as f:
            f.write(audio_bytes)

        print(f"[GENERATE] Saved audio to: {s3_path}")

        audio_url = f"/audio/{relative_key}"

        return TextToSpeechResponse(s3_Key=relative_key, audio_url=audio_url)
    except HTTPException:
        raise
    except Exception as e:
        print(f"[GENERATE ERROR] {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=f"Generation failed: {str(e)}")


@app.post("/upload-voice", response_model=UploadVoiceResponse)
async def upload_voice(
    voice: UploadFile = File(...),
    user_id: str = Form(...),
):
    if not voice.content_type or not voice.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="File must be audio type")

    ext = Path(voice.filename or "audio.wav").suffix.lower() or ".wav"
    allowed_exts = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}
    if ext not in allowed_exts:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported audio format. Allowed: {sorted(allowed_exts)}",
        )

    safe_user_id = "".join(c for c in user_id if c.isalnum() or c in ("-", "_"))
    if not safe_user_id:
        safe_user_id = "anonymous"

    voice_dir = STORAGE_PATH / "voices" / safe_user_id
    voice_dir.mkdir(parents=True, exist_ok=True)

    file_uuid = str(uuid.uuid4())
    file_name = f"{file_uuid}{ext}"
    file_path_full = voice_dir / file_name

    contents = await voice.read()
    if len(contents) == 0:
        raise HTTPException(status_code=400, detail="Empty file")

    MAX_SIZE = 10 * 1024 * 1024
    if len(contents) > MAX_SIZE:
        raise HTTPException(status_code=400, detail="File too large (max 10MB)")

    with open(file_path_full, "wb") as f:
        f.write(contents)

    relative_path = f"voices/{safe_user_id}/{file_name}"
    url = f"/audio/{relative_path}"

    print(f"[UPLOAD] Saved voice to: {file_path_full}")

    return UploadVoiceResponse(
        file_path=relative_path,
        url=url,
        file_name=voice.filename or file_name,
    )


@app.get("/audio-file/{sub_path:path}")
async def get_audio_file_direct(sub_path: str):
    file_path = STORAGE_PATH / sub_path
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        path=str(file_path),
        media_type="audio/wav" if file_path.suffix == ".wav" else "application/octet-stream",
        filename=file_path.name,
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("TTS_API_PORT", "8000"))
    uvicorn.run("tts:app", host="0.0.0.0", port=port, reload=True)
