"""
Download and cache remote media assets (videos, images, fonts, audio).
"""
import os
import hashlib
import asyncio
from urllib.parse import urlparse, urlunparse
from typing import Optional

import httpx


CACHE_DIR = os.path.join(os.path.dirname(__file__), "..", "_cache")
UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "..", "uploads")


def _ensure_cache_dir():
    os.makedirs(CACHE_DIR, exist_ok=True)


def _cache_key(url: str) -> str:
    h = hashlib.sha256(url.encode()).hexdigest()[:16]
    ext = os.path.splitext(urlparse(url).path)[1] or ""
    return f"{h}{ext}"


def get_cached_path(url: str) -> Optional[str]:
    path = os.path.join(CACHE_DIR, _cache_key(url))
    return path if os.path.exists(path) else None


def _url_variants(url: str) -> list[str]:
    """Same resource may appear as localhost vs 127.0.0.1 or with/without trailing slash."""
    u = url.strip()
    out = [u]
    try:
        p = urlparse(u)
        if p.netloc:
            host = p.hostname or ""
            if host == "localhost":
                alt = urlunparse(
                    (
                        p.scheme,
                        p.netloc.replace("localhost", "127.0.0.1", 1),
                        p.path,
                        p.params,
                        p.query,
                        p.fragment,
                    )
                )
                if alt not in out:
                    out.append(alt)
            elif host == "127.0.0.1":
                alt = urlunparse(
                    (
                        p.scheme,
                        p.netloc.replace("127.0.0.1", "localhost", 1),
                        p.path,
                        p.params,
                        p.query,
                        p.fragment,
                    )
                )
                if alt not in out:
                    out.append(alt)
        path = p.path.rstrip("/")
        if path != p.path:
            alt = urlunparse(
                (p.scheme, p.netloc, path, p.params, p.query, p.fragment)
            )
            if alt not in out:
                out.append(alt)
    except Exception:
        pass
    return out


def _resolve_local_upload_file(url: str) -> Optional[str]:
    """
    Map http://localhost:8000/api/uploads/files/foo.mp4 to on-disk uploads/foo.mp4
    when the file exists (avoids HTTP self-fetch issues).
    """
    try:
        p = urlparse(url)
        marker = "/api/uploads/files/"
        if marker not in p.path:
            return None
        name = p.path.split(marker, 1)[-1].strip("/")
        safe = os.path.basename(name)
        if not safe or safe != name.strip("/"):
            return None
        local = os.path.join(UPLOADS_DIR, safe)
        return local if os.path.isfile(local) else None
    except Exception:
        return None


async def download_file(url: str, dest: Optional[str] = None) -> str:
    """Download a URL to the cache directory. Returns local file path."""
    _ensure_cache_dir()
    if dest is None:
        dest = os.path.join(CACHE_DIR, _cache_key(url))
    if os.path.exists(dest):
        return dest
    async with httpx.AsyncClient(
        follow_redirects=True, timeout=120.0, verify=False
    ) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            with open(dest, "wb") as f:
                async for chunk in resp.aiter_bytes(chunk_size=65536):
                    f.write(chunk)
    return dest


def _register_asset(asset_map: dict[str, str], url: str, local_path: str) -> None:
    """Store path under url and all known variants so design JSON keys always resolve."""
    for key in _url_variants(url):
        asset_map[key] = local_path


async def download_assets(design_dict: dict, work_dir: str) -> dict[str, str]:
    """
    Scan design for remote URLs and download them all.
    Returns a mapping of URL -> local_file_path.
    """
    urls = set()
    items_map = design_dict.get("trackItemsMap", {})
    for item in items_map.values():
        details = item.get("details", {})
        metadata = item.get("metadata", {})
        for key in (
            details.get("src"),
            details.get("fontUrl"),
            details.get("originalSrc"),
            metadata.get("originalSrc"),
            metadata.get("originalUrl"),
            metadata.get("proxyUrl"),
            metadata.get("proxySrc"),
            metadata.get("uploadedUrl"),
        ):
            if key:
                urls.add(str(key).strip())

    asset_map: dict[str, str] = {}
    tasks = []

    for url in urls:
        if not url:
            continue
        # Absolute filesystem path (some exports use file paths)
        if url.startswith("/") and os.path.isfile(url):
            _register_asset(asset_map, url, url)
            continue
        if url.startswith("file://"):
            path = url[7:]
            if os.path.isfile(path):
                _register_asset(asset_map, url, path)
            continue

        local_upload = _resolve_local_upload_file(url)
        if local_upload:
            _register_asset(asset_map, url, local_upload)
            continue

        hit = None
        for variant in _url_variants(url):
            cached = get_cached_path(variant)
            if cached:
                hit = cached
                break
        if hit:
            _register_asset(asset_map, url, hit)
            continue

        tasks.append((url, download_file(url)))

    results = await asyncio.gather(*[t[1] for t in tasks], return_exceptions=True)
    for (url, _), result in zip(tasks, results):
        if isinstance(result, Exception):
            print(f"[WARN] Failed to download {url}: {result}")
        else:
            _register_asset(asset_map, url, result)

    return asset_map
