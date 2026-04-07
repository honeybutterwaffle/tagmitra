import os
import uuid
import asyncio
import traceback
import mimetypes
from contextlib import asynccontextmanager

from fastapi import FastAPI, BackgroundTasks, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, List

from jobs.manager import job_manager, JobStatus
from renderer.engine import render_design


# ── Directories ───────────────────────────────────────────────────
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")
WORK_DIR = os.path.join(os.path.dirname(__file__), "_work")
UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(WORK_DIR, exist_ok=True)
os.makedirs(UPLOADS_DIR, exist_ok=True)


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
    Upload a media file locally. Returns a local URL that the editor
    can use as details.src. Replaces the cloud presign+PUT flow.
    """
    try:
        # Generate unique filename to avoid collisions
        ext = os.path.splitext(file.filename or "")[1] or ""
        unique_name = f"{uuid.uuid4().hex[:12]}{ext}"
        dest_path = os.path.join(UPLOADS_DIR, unique_name)

        # Write file to disk
        content = await file.read()
        with open(dest_path, "wb") as f:
            f.write(content)

        # Determine content type
        content_type = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"

        # Build the URL the frontend will use to reference this file
        file_url = f"http://localhost:8000/api/uploads/files/{unique_name}"

        print(f"[UPLOAD] Saved {file.filename} -> {dest_path} ({len(content)} bytes)")

        return {
            "success": True,
            "uploads": [
                {
                    "fileName": file.filename,
                    "filePath": dest_path,
                    "contentType": content_type,
                    "url": file_url,
                    "presignedUrl": file_url,
                    "folder": None,
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
    return FileResponse(
        file_path,
        media_type=content_type,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400",
        },
    )


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
