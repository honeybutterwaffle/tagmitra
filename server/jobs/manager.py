"""
In-memory job manager for tracking render job status and progress.
"""
import uuid
import asyncio
from dataclasses import dataclass, field
from typing import Optional
from enum import Enum


class JobStatus(str, Enum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


@dataclass
class RenderJob:
    id: str
    status: JobStatus = JobStatus.PENDING
    progress: float = 0
    message: str = ""
    output_path: Optional[str] = None
    error: Optional[str] = None


class JobManager:
    """Thread-safe in-memory job store."""

    def __init__(self):
        self._jobs: dict[str, RenderJob] = {}
        self._lock = asyncio.Lock()

    async def create_job(self) -> RenderJob:
        job_id = str(uuid.uuid4())
        job = RenderJob(id=job_id)
        async with self._lock:
            self._jobs[job_id] = job
        return job

    async def get_job(self, job_id: str) -> Optional[RenderJob]:
        async with self._lock:
            return self._jobs.get(job_id)

    async def update_job(
        self,
        job_id: str,
        status: Optional[JobStatus] = None,
        progress: Optional[float] = None,
        message: Optional[str] = None,
        output_path: Optional[str] = None,
        error: Optional[str] = None,
    ):
        async with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            if status is not None:
                job.status = status
            if progress is not None:
                job.progress = progress
            if message is not None:
                job.message = message
            if output_path is not None:
                job.output_path = output_path
            if error is not None:
                job.error = error


# Singleton
job_manager = JobManager()
