import os
import re
import uuid
import asyncio
import traceback
import mimetypes
import subprocess
import urllib.parse
from contextlib import asynccontextmanager

from fastapi import FastAPI, BackgroundTasks, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, List

from jobs.manager import job_manager, JobStatus
from renderer.engine import render_design, _probe_resolution, _probe_media_duration_sec
from renderer.package_alpha import analyze_package_alpha


# ── Directories ───────────────────────────────────────────────────
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")
WORK_DIR = os.path.join(os.path.dirname(__file__), "_work")
UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(WORK_DIR, exist_ok=True)
os.makedirs(UPLOADS_DIR, exist_ok=True)


def _resolve_local_media_path(raw: Optional[str]) -> Optional[str]:
    """
    Map client URLs or paths to a readable file under this server.
    Handles 127.0.0.1 vs localhost, URL-encoded filenames, and absolute paths.
    """
    if not raw or not str(raw).strip():
        return None
    s = str(raw).strip()
    if os.path.isfile(s):
        return s
    parsed = urllib.parse.urlparse(s)
    path_part = parsed.path or s
    m = re.search(r"/api/uploads/files/(.+)$", path_part)
    if m:
        name = urllib.parse.unquote(m.group(1).split("?")[0])
        candidate = os.path.join(UPLOADS_DIR, name)
        if os.path.isfile(candidate):
            return candidate
    for prefix in (
        "http://localhost:8000/api/uploads/files/",
        "http://127.0.0.1:8000/api/uploads/files/",
    ):
        if s.startswith(prefix):
            tail = urllib.parse.unquote(s[len(prefix) :].split("?")[0])
            candidate = os.path.join(UPLOADS_DIR, tail)
            if os.path.isfile(candidate):
                return candidate
    return None


# ── App lifecycle ─────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[SERVER] TagMitra Render Server started")
    yield
    print("[SERVER] TagMitra Render Server shutting down")


app = FastAPI(
    title="TagMitra Render Server",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS for local Next.js dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


# ── Request / Response models ─────────────────────────────────────
class RenderRequestBody(BaseModel):
    design: dict
    options: dict = {}


class RenderResponse(BaseModel):
    render: dict


# ── Background render task ────────────────────────────────────────
async def _run_render(job_id: str, design: dict, options: dict):
    """Background task that performs the actual rendering."""
    try:
        await job_manager.update_job(
            job_id, status=JobStatus.PROCESSING, progress=5
        )

        work_dir = os.path.join(WORK_DIR, job_id)
        os.makedirs(work_dir, exist_ok=True)

        async def progress_cb(progress: float, message: str = ""):
            await job_manager.update_job(
                job_id, progress=progress, message=message
            )

        output_path = await render_design(design, options, work_dir, progress_cb)

        # Move output to served directory
        final_path = os.path.join(OUTPUT_DIR, f"{job_id}.mp4")
        os.rename(output_path, final_path)

        await job_manager.update_job(
            job_id,
            status=JobStatus.COMPLETED,
            progress=100,
            output_path=final_path,
            message="Render complete",
        )
        print(f"[SERVER] Job {job_id} completed: {final_path}")

    except Exception as e:
        traceback.print_exc()
        await job_manager.update_job(
            job_id,
            status=JobStatus.FAILED,
            error=str(e),
            message=f"Render failed: {e}",
        )


# ── Render routes ─────────────────────────────────────────────────
@app.post("/api/render")
async def start_render(body: RenderRequestBody, background_tasks: BackgroundTasks):
    """
    Start a new render job. Returns immediately with a job ID.
    The frontend polls GET /api/render/{id} for status.
    """
    job = await job_manager.create_job()
    background_tasks.add_task(_run_render, job.id, body.design, body.options)

    return {
        "render": {
            "id": job.id,
            "status": job.status.value,
            "progress": 0,
        }
    }


@app.get("/api/render/{job_id}")
async def get_render_status(job_id: str):
    """
    Poll render job status. Returns status, progress, and download URL when done.
    Matches the response shape the frontend expects.
    """
    job = await job_manager.get_job(job_id)
    if not job:
        return JSONResponse(
            {"message": "Job not found"}, status_code=404
        )

    result = {
        "render": {
            "id": job.id,
            "status": job.status.value,
            "progress": job.progress,
        }
    }

    if job.status == JobStatus.COMPLETED and job.output_path:
        result["render"]["presigned_url"] = (
            f"http://localhost:8000/api/render/{job_id}/download"
        )

    if job.error:
        result["render"]["error"] = job.error

    return result


@app.get("/api/render/{job_id}/download")
async def download_render(job_id: str):
    """Serve the rendered video file."""
    job = await job_manager.get_job(job_id)
    if not job or not job.output_path:
        return JSONResponse(
            {"message": "File not found"}, status_code=404
        )

    if not os.path.exists(job.output_path):
        return JSONResponse(
            {"message": "File no longer available"}, status_code=404
        )

    return FileResponse(
        job.output_path,
        media_type="video/mp4",
        filename=f"tagmitra_export_{job_id[:8]}.mp4",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


# ── Upload routes ─────────────────────────────────────────────────
@app.post("/api/uploads/file")
async def upload_file(file: UploadFile = File(...)):
    """
    Upload a media file locally. Generates a 720p proxy for video for preview,
    while keeping the original for final render. Returns both URLs.
    """
    try:
        # Generate unique filename to avoid collisions
        ext = os.path.splitext(file.filename or "")[1] or ""
        unique_name = f"{uuid.uuid4().hex[:12]}{ext}"
        dest_path = os.path.join(UPLOADS_DIR, unique_name)

        # Stream write file to disk to avoid loading huge files into memory
        with open(dest_path, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)

        # Determine content type
        content_type = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"

        # Normalise known professional/container formats that browsers and
        # Python's mimetypes module don't map to video/* or audio/*
        _VIDEO_EXTS = {".mxf", ".mov", ".avi", ".wmv", ".flv", ".mkv", ".m4v",
                       ".ts", ".m2ts", ".mts", ".3gp", ".3g2", ".ogv"}
        _AUDIO_EXTS = {".wav", ".aac", ".flac", ".ogg", ".wma", ".m4a", ".opus"}
        ext_lower = ext.lower()
        if not content_type.startswith(("video/", "audio/", "image/")):
            if ext_lower in _VIDEO_EXTS:
                content_type = f"video/{ext_lower.lstrip('.')}"
            elif ext_lower in _AUDIO_EXTS:
                content_type = f"audio/{ext_lower.lstrip('.')}"

        # Build URLs for original and proxy
        original_url = f"http://localhost:8000/api/uploads/files/{unique_name}"

        proxy_url = original_url
        alpha_proxy_url = None
        if content_type.startswith("video/"):
            proxy_name = f"proxy_{uuid.uuid4().hex[:8]}.mp4"
            proxy_path = os.path.join(UPLOADS_DIR, proxy_name)
            cmd = [
                "ffmpeg",
                "-y",
                "-i",
                dest_path,
                "-vf",
                "scale='min(1280,iw)':-2",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "22",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                proxy_path,
            ]
            try:
                proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
                proxy_url = f"http://localhost:8000/api/uploads/files/{proxy_name}"
            except Exception as proxy_err:
                stderr = ""
                if isinstance(proxy_err, subprocess.CalledProcessError):
                    stderr = proxy_err.stderr or ""
                print(f"[UPLOAD] Proxy generation failed, using original: {proxy_err}\n{stderr}")
                proxy_url = original_url

            # When the source has an alpha channel (e.g. ProRes 4444 .mov)
            # generate a grayscale "alpha mask" video:
            #   white = transparent (hole where slate should show)
            #   black = opaque (package content visible)
            # The client uses mix-blend-mode compositing with this mask.
            try:
                pix_cmd = [
                    "ffprobe", "-v", "error", "-select_streams", "v:0",
                    "-show_entries", "stream=pix_fmt", "-of", "csv=p=0",
                    dest_path,
                ]
                pix_result = subprocess.run(
                    pix_cmd, capture_output=True, text=True, timeout=10
                )
                pix_fmt = pix_result.stdout.strip().lower()
                has_alpha = any(
                    tag in pix_fmt
                    for tag in ("yuva", "argb", "rgba", "bgra", "gbra", "ayuv")
                )
                if has_alpha:
                    alpha_name = f"mask_{uuid.uuid4().hex[:8]}.mp4"
                    alpha_path = os.path.join(UPLOADS_DIR, alpha_name)
                    alpha_cmd = [
                        "ffmpeg", "-y", "-i", dest_path,
                        "-vf", "alphaextract,negate,scale='min(1280,iw)':-2",
                        "-c:v", "libx264",
                        "-pix_fmt", "yuv420p",
                        "-crf", "22",
                        "-preset", "veryfast",
                        "-movflags", "+faststart",
                        "-an",
                        alpha_path,
                    ]
                    subprocess.run(
                        alpha_cmd, check=True, capture_output=True, text=True
                    )
                    alpha_proxy_url = (
                        f"http://localhost:8000/api/uploads/files/{alpha_name}"
                    )
                    print(f"[UPLOAD] Generated alpha mask video: {alpha_name}")
            except Exception as alpha_err:
                stderr_a = ""
                if isinstance(alpha_err, subprocess.CalledProcessError):
                    stderr_a = alpha_err.stderr or ""
                print(
                    f"[UPLOAD] Alpha mask generation skipped (non-fatal): "
                    f"{alpha_err}\n{stderr_a}"
                )

        elif content_type.startswith("audio/"):
            proxy_name = f"proxy_{uuid.uuid4().hex[:8]}.m4a"
            proxy_path = os.path.join(UPLOADS_DIR, proxy_name)
            cmd = [
                "ffmpeg",
                "-y",
                "-i",
                dest_path,
                "-vn",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                "-ar",
                "48000",
                "-ac",
                "2",
                proxy_path,
            ]
            try:
                proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
                proxy_url = f"http://localhost:8000/api/uploads/files/{proxy_name}"
            except Exception as proxy_err:
                stderr = ""
                if isinstance(proxy_err, subprocess.CalledProcessError):
                    stderr = proxy_err.stderr or ""
                print(f"[UPLOAD] Audio proxy generation failed, using original: {proxy_err}\n{stderr}")
                proxy_url = original_url

        print(f"[UPLOAD] Saved {file.filename} -> {dest_path}")

        # Probe duration and dimensions at upload time so the client never needs
        # separate /api/probe/* calls for files it just uploaded.
        probed: dict = {}
        if content_type.startswith(("video/", "audio/")):
            try:
                probe_cmd = [
                    "ffprobe", "-v", "quiet", "-print_format", "json",
                    "-show_format", "-show_streams", dest_path,
                ]
                probe_result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=15)
                if probe_result.returncode == 0:
                    import json as _json
                    info = _json.loads(probe_result.stdout)
                    fmt = info.get("format", {})
                    dur = float(fmt.get("duration", 0))
                    probed["duration_sec"] = round(dur, 4) if dur > 0 else 0

                    for s in info.get("streams", []):
                        if s.get("codec_type") == "video":
                            w = int(s.get("width", 0))
                            h = int(s.get("height", 0))
                            if w > 0 and h > 0:
                                probed["width"] = w
                                probed["height"] = h
                                probed["aspect"] = round(w / h, 6)
                            break
            except Exception as probe_err:
                print(f"[UPLOAD] Probe failed (non-fatal): {probe_err}")

        return {
            "success": True,
            "uploads": [
                {
                    "fileName": file.filename,
                    "filePath": dest_path,
                    "contentType": content_type,
                    "url": proxy_url,
                    "proxyUrl": proxy_url,
                    "originalUrl": original_url,
                    "alphaProxyUrl": alpha_proxy_url,
                    "presignedUrl": proxy_url,
                    "folder": None,
                    **probed,
                }
            ]
        }

    except Exception as e:
        traceback.print_exc()
        return JSONResponse(
            {"error": str(e)},
            status_code=500,
        )


@app.get("/api/uploads/files/{filename}")
async def serve_uploaded_file(filename: str):
    """Serve an uploaded media file."""
    file_path = os.path.join(UPLOADS_DIR, filename)
    if not os.path.exists(file_path):
        return JSONResponse({"message": "File not found"}, status_code=404)

    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    response = FileResponse(
        file_path,
        media_type=content_type,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400",
            "Accept-Ranges": "bytes",
        },
    )
    return response


@app.post("/api/analyze/alpha")
async def analyze_alpha(body: dict):
    """
    When a package is selected: detect the black alpha hole (contour bbox) in time.

    Accepts { filePath: str } or { url: str }, optional source_aspect (float, default 16/9).

    Returns:
      - alpha: legacy { x, y, w, h, start_sec } when the hole first appears
      - keyframes: time-varying bbox samples
      - slate_fit: default width/height/left/top centered in hole (max side = contour max side)
      - resolution, fps
    """
    raw = body.get("filePath") or body.get("url") or ""
    local_path = _resolve_local_media_path(raw)

    if not local_path:
        return JSONResponse({"error": "File not found", "path": raw}, status_code=404)

    try:
        src_ar = float(body.get("source_aspect") or (16.0 / 9.0))
    except (TypeError, ValueError):
        src_ar = 16.0 / 9.0

    analysis = analyze_package_alpha(local_path, source_aspect=src_ar)
    alpha = analysis.get("alpha_box")
    pw, ph = _probe_resolution(local_path)
    if (not pw or not ph) and analysis.get("resolution"):
        pw = int(analysis["resolution"].get("width") or 0)
        ph = int(analysis["resolution"].get("height") or 0)

    return {
        "alpha": alpha,
        "keyframes": analysis.get("keyframes") or [],
        "slate_fit": analysis.get("slate_fit"),
        "resolution": {"width": pw, "height": ph},
        "fps": analysis.get("fps"),
    }


@app.post("/api/probe/dimensions")
async def probe_dimensions(body: dict):
    """
    Probe video/image width and height for aspect ratio (slate_fit source_aspect).
    Accepts { filePath: str } or { url: str }.
    """
    raw = body.get("filePath") or body.get("url") or ""
    local_path = _resolve_local_media_path(raw)

    if not local_path:
        return JSONResponse({"error": "File not found", "path": raw}, status_code=404)

    w, h = _probe_resolution(local_path)
    aspect = (float(w) / float(h)) if h else 0.0
    return {"width": w, "height": h, "aspect": aspect}


@app.post("/api/probe/duration")
async def probe_duration(body: dict):
    """
    Probe media duration for a file.
    Accepts { filePath: str } or { url: str }.
    Returns { duration_sec: float }.
    """
    raw = body.get("filePath") or body.get("url") or ""
    local_path = _resolve_local_media_path(raw)

    if not local_path:
        return JSONResponse({"error": "File not found", "path": raw}, status_code=404)

    dur = _probe_media_duration_sec(local_path)
    return {"duration_sec": dur}


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
