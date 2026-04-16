import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { processUpload } from "@/utils/upload-service";
import { dispatch } from "@designcombo/events";
import {
  ADD_AUDIO,
  ADD_VIDEO,
  LAYER_DELETE
} from "@designcombo/state";
import { generateId } from "@designcombo/timeline";
import { GripVertical, Music2, Pause, Play, UploadIcon, Video as VideoIcon } from "lucide-react";
import ModalUpload from "@/components/modal-upload";
import useUploadStore from "../store/use-upload-store";
import useStore from "../store/use-store";
import { toast } from "sonner";
import {
  applyHoleLayoutAfterPromoAdd,
  getItemsForRole,
  promoHoleLayoutFromAlpha,
  resolvePackageAlphaForPromo,
  resolvePromoUploadUrls
} from "../utils/promo-timeline-apply";

import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  UniqueIdentifier
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// ── Get duration from upload metadata (already probed at upload time) ──
function getDurationFromUpload(upload: any): number {
  const dur =
    upload?.metadata?.duration_sec ??
    upload?.duration_sec ??
    0;
  if (!dur) {
    console.warn("[assets] duration_sec is 0/missing for", upload?.fileName);
  }
  return dur;
}

// ── Thumbnail extraction from URL ──────────────────────────────
function extractThumbnailFromUrl(videoUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.src = videoUrl;
    video.currentTime = 1;
    video.muted = true;
    video.playsInline = true;
    video.onloadeddata = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 320;
        canvas.height = video.videoHeight || 240;
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      } catch {
        resolve("");
      }
    };
    video.onerror = () => resolve("");
    setTimeout(() => resolve(""), 8000);
  });
}

// ── Word-level matching ────────────────────────────────────────
function stemTokens(name: string): string[] {
  return name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function matchScore(a: string, b: string): number {
  const ta = new Set(stemTokens(a));
  const tb = new Set(stemTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / Math.max(ta.size, tb.size);
}

export interface AssetPair {
  id: string;
  video: any | null;
  audio: any | null;
}

function autoMatchAssets(videos: any[], audios: any[]): AssetPair[] {
  const scored: { vi: number; ai: number; score: number }[] = [];
  for (let vi = 0; vi < videos.length; vi++) {
    const vName = videos[vi].fileName || videos[vi].file?.name || "";
    for (let ai = 0; ai < audios.length; ai++) {
      const aName = audios[ai].fileName || audios[ai].file?.name || "";
      const s = matchScore(vName, aName);
      if (s > 0) scored.push({ vi, ai, score: s });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const usedVideoIdx = new Set<number>();
  const usedAudioIdx = new Set<number>();
  const pairs: AssetPair[] = [];

  for (const { vi, ai } of scored) {
    if (usedVideoIdx.has(vi) || usedAudioIdx.has(ai)) continue;
    usedVideoIdx.add(vi);
    usedAudioIdx.add(ai);
    pairs.push({ id: generateId(), video: videos[vi], audio: audios[ai] });
  }
  for (let vi = 0; vi < videos.length; vi++) {
    if (!usedVideoIdx.has(vi))
      pairs.push({ id: generateId(), video: videos[vi], audio: null });
  }
  for (let ai = 0; ai < audios.length; ai++) {
    if (!usedAudioIdx.has(ai))
      pairs.push({ id: generateId(), video: null, audio: audios[ai] });
  }
  return pairs;
}

// ── Helper: get unique drag ID for an item within a pair ───────
function videoSlotId(pairId: string) { return `v::${pairId}`; }
function audioSlotId(pairId: string) { return `a::${pairId}`; }
function parseSlotId(id: string): { type: "video" | "audio"; pairId: string } | null {
  if (id.startsWith("v::")) return { type: "video", pairId: id.slice(3) };
  if (id.startsWith("a::")) return { type: "audio", pairId: id.slice(3) };
  return null;
}

// ── Main component ─────────────────────────────────────────────
export function AssetsMenu() {
  const { setShowUploadModal, uploads, removeUploadAsset, activeUploads, pendingUploads } = useUploadStore();
  const setAlphaInfo = useStore((s) => s.setAlphaInfo);
  const [pairs, setPairs] = useState<AssetPair[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [appliedToTimeline, setAppliedToTimeline] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [activeSlotDrag, setActiveSlotDrag] = useState<{ type: "video" | "audio"; pairId: string } | null>(null);
  const knownUploadIdsRef = useRef<Set<string>>(new Set());
  const [pickingSlot, setPickingSlot] = useState<{ pairId: string; type: "video" | "audio" } | null>(null);

  const isUploading = useMemo(
    () => pendingUploads.length > 0 || activeUploads.length > 0,
    [pendingUploads, activeUploads]
  );

  const assetUploads = useMemo(
    () => uploads.filter((u) => u.metadata?.promoRole === "asset"),
    [uploads]
  );

  const assetVideos = useMemo(
    () =>
      assetUploads.filter(
        (u) =>
          u.contentType?.startsWith("video/") ||
          u.type === "video" ||
          u.metadata?.contentType?.startsWith("video/")
      ),
    [assetUploads]
  );

  const assetAudios = useMemo(
    () =>
      assetUploads.filter(
        (u) =>
          u.contentType?.startsWith("audio/") ||
          u.type === "audio" ||
          u.metadata?.contentType?.startsWith("audio/")
      ),
    [assetUploads]
  );

  // ── Persist / restore pair arrangement ─────────────────────
  const PAIRS_STORAGE_KEY = "tagmitra_asset_pairs";

  const savePairsToStorage = useCallback((p: AssetPair[]) => {
    try {
      const slim = p.map((pair) => ({
        id: pair.id,
        videoKey: pair.video ? (pair.video.id || pair.video.fileName || "") : null,
        audioKey: pair.audio ? (pair.audio.id || pair.audio.fileName || "") : null
      }));
      localStorage.setItem(PAIRS_STORAGE_KEY, JSON.stringify(slim));
    } catch {}
  }, []);

  const restorePairsFromStorage = useCallback(
    (videos: any[], audios: any[]): AssetPair[] | null => {
      try {
        const raw = localStorage.getItem(PAIRS_STORAGE_KEY);
        if (!raw) return null;
        const slim = JSON.parse(raw) as { id: string; videoKey: string | null; audioKey: string | null }[];
        if (!Array.isArray(slim) || slim.length === 0) return null;

        const videoMap = new Map<string, any>();
        for (const v of videos) videoMap.set(v.id || v.fileName || "", v);
        const audioMap = new Map<string, any>();
        for (const a of audios) audioMap.set(a.id || a.fileName || "", a);

        const usedV = new Set<string>();
        const usedA = new Set<string>();
        const restored: AssetPair[] = [];

        for (const entry of slim) {
          const video = entry.videoKey ? videoMap.get(entry.videoKey) || null : null;
          const audio = entry.audioKey ? audioMap.get(entry.audioKey) || null : null;
          if (video) usedV.add(entry.videoKey!);
          if (audio) usedA.add(entry.audioKey!);
          if (video || audio) restored.push({ id: entry.id, video, audio });
        }

        // Add any uploads that weren't in the saved arrangement
        for (const v of videos) {
          const k = v.id || v.fileName || "";
          if (!usedV.has(k)) restored.push({ id: generateId(), video: v, audio: null });
        }
        for (const a of audios) {
          const k = a.id || a.fileName || "";
          if (!usedA.has(k)) restored.push({ id: generateId(), video: null, audio: a });
        }

        return restored.length > 0 ? restored : null;
      } catch {
        return null;
      }
    },
    []
  );

  // Save whenever pairs change
  useEffect(() => {
    if (pairs.length > 0) savePairsToStorage(pairs);
  }, [pairs, savePairsToStorage]);

  // Auto-match only truly NEW uploads; debounced so rapid arrivals don't
  // interrupt the editor while uploads complete in the background.
  const matchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    // First load (or reload): restore immediately, no debounce
    if (!initializedRef.current && (assetVideos.length > 0 || assetAudios.length > 0)) {
      initializedRef.current = true;
      const allIds = new Set(assetUploads.map((u) => u.id || u.fileName || ""));
      knownUploadIdsRef.current = allIds;
      const restored = restorePairsFromStorage(assetVideos, assetAudios);
      setPairs(restored || autoMatchAssets(assetVideos, assetAudios));
      return;
    }

    if (!initializedRef.current) return;

    // Debounce incremental matching so dragging/shuffling isn't interrupted
    if (matchTimerRef.current) clearTimeout(matchTimerRef.current);
    matchTimerRef.current = setTimeout(() => {
      const currentIds = new Set(assetUploads.map((u) => u.id || u.fileName || ""));
      const newVideos = assetVideos.filter((v) => !knownUploadIdsRef.current.has(v.id || v.fileName || ""));
      const newAudios = assetAudios.filter((a) => !knownUploadIdsRef.current.has(a.id || a.fileName || ""));
      knownUploadIdsRef.current = currentIds;

      if (newVideos.length === 0 && newAudios.length === 0) return;

      setPairs((prev) => {
        const pairedVideoIds = new Set(prev.filter((p) => p.video).map((p) => p.video.id || p.video.fileName || ""));
        const pairedAudioIds = new Set(prev.filter((p) => p.audio).map((p) => p.audio.id || p.audio.fileName || ""));

        const unmatchedNewVideos = newVideos.filter((v) => !pairedVideoIds.has(v.id || v.fileName || ""));
        const unmatchedNewAudios = newAudios.filter((a) => !pairedAudioIds.has(a.id || a.fileName || ""));

        if (unmatchedNewVideos.length === 0 && unmatchedNewAudios.length === 0) return prev;

        const newPairs = autoMatchAssets(unmatchedNewVideos, unmatchedNewAudios);
        const next = [...prev];
        for (const np of newPairs) {
          if (np.video && !np.audio) {
            const slot = next.find((p) => !p.video && p.audio);
            if (slot) { slot.video = np.video; continue; }
          }
          if (np.audio && !np.video) {
            const slot = next.find((p) => !p.audio && p.video);
            if (slot) { slot.audio = np.audio; continue; }
          }
          next.push(np);
        }
        return next;
      });
    }, 800);

    return () => { if (matchTimerRef.current) clearTimeout(matchTimerRef.current); };
  }, [assetVideos, assetAudios]);

  // Generate thumbnails from proxy URLs
  useEffect(() => {
    for (const v of assetVideos) {
      const key = v.id || v.fileName;
      if (thumbnails[key]) continue;
      const proxyUrl = v.metadata?.proxyUrl || v.metadata?.uploadedUrl || v.url;
      if (proxyUrl) {
        extractThumbnailFromUrl(proxyUrl).then((thumb) => {
          if (thumb) setThumbnails((prev) => ({ ...prev, [key]: thumb }));
        });
      }
    }
  }, [assetVideos]);

  // ── dnd-kit: sortable (pair reorder) + slot swaps ─────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const pairIds = useMemo(() => pairs.map((p) => p.id), [pairs]);

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    const parsed = parseSlotId(id);
    if (parsed) setActiveSlotDrag(parsed);
    else setActiveSlotDrag(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveSlotDrag(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    const activeParsed = parseSlotId(activeId);
    const overParsed = parseSlotId(overId);

    // Slot-level drag (swap audio or video between pairs)
    if (activeParsed && overParsed && activeParsed.type === overParsed.type) {
      setPairs((prev) => {
        const next = prev.map((p) => ({ ...p }));
        const fromIdx = next.findIndex((p) => p.id === activeParsed.pairId);
        const toIdx = next.findIndex((p) => p.id === overParsed.pairId);
        if (fromIdx === -1 || toIdx === -1) return prev;
        const field = activeParsed.type;
        const tmp = next[fromIdx][field];
        next[fromIdx][field] = next[toIdx][field];
        next[toIdx][field] = tmp;
        return next.filter((p) => p.video || p.audio);
      });
      return;
    }

    // Pair-level drag (reorder)
    if (!activeParsed && !overParsed) {
      const oldIdx = pairs.findIndex((p) => p.id === activeId);
      const newIdx = pairs.findIndex((p) => p.id === overId);
      if (oldIdx !== -1 && newIdx !== -1) {
        setPairs((prev) => arrayMove(prev, oldIdx, newIdx));
      }
    }
  };

  // ── Remove individual video or audio from a pair ────────────
  const handleRemoveVideo = useCallback((pairId: string) => {
    setPairs((prev) => {
      const updated: AssetPair[] = [];
      for (const p of prev) {
        if (p.id !== pairId) { updated.push(p); continue; }
        if (p.video) removeUploadAsset(p.video.id || p.video.fileName || "");
        if (p.audio) {
          updated.push({ ...p, video: null });
        }
        // if both would be null, just drop the pair entirely
      }
      return updated;
    });
  }, [removeUploadAsset]);

  const handleRemoveAudio = useCallback((pairId: string) => {
    setPairs((prev) => {
      const updated: AssetPair[] = [];
      for (const p of prev) {
        if (p.id !== pairId) { updated.push(p); continue; }
        if (p.audio) removeUploadAsset(p.audio.id || p.audio.fileName || "");
        if (p.video) {
          updated.push({ ...p, audio: null });
        }
      }
      return updated;
    });
  }, [removeUploadAsset]);

  const handleAssignToSlot = useCallback((pairId: string, type: "video" | "audio", asset: any) => {
    setPairs((prev) => {
      // Remove asset from its current pair if it's in one
      const assetKey = asset.id || asset.fileName || "";
      let next = prev.map((p) => {
        if (type === "video" && p.video && (p.video.id || p.video.fileName || "") === assetKey) {
          return { ...p, video: null };
        }
        if (type === "audio" && p.audio && (p.audio.id || p.audio.fileName || "") === assetKey) {
          return { ...p, audio: null };
        }
        return p;
      });
      // Assign to the target slot
      next = next.map((p) => {
        if (p.id === pairId) return { ...p, [type]: asset };
        return p;
      });
      // Drop pairs that became fully empty
      return next.filter((p) => p.video || p.audio);
    });
    setPickingSlot(null);
  }, []);

  // ── Apply to timeline ────────────────────────────────────────
  const applyAllToTimeline = useCallback(async () => {
    setIsApplying(true);
    try {
      const trackItemsMap = useStore.getState().trackItemsMap || {};
      const pkgs = getItemsForRole(trackItemsMap, "package");
      if (!pkgs.length) {
        toast.error("Add a package to the timeline first.");
        return;
      }

      const alpha = await resolvePackageAlphaForPromo(trackItemsMap, setAlphaInfo);
      if (!alpha) {
        toast.error("Could not detect the package alpha hole.");
        return;
      }
      const layout = promoHoleLayoutFromAlpha(alpha);
      if (!layout) {
        toast.error("Alpha detection returned no layout box.");
        return;
      }
      const alphaStartMs = (alpha.startSec ?? 0) * 1000;

      // Remove existing video/audio items
      const existingVideos = getItemsForRole(trackItemsMap, "video");
      const existingAudios = getItemsForRole(trackItemsMap, "audio");
      const toDelete = [
        ...existingVideos.map((i: any) => i.id),
        ...existingAudios.map((i: any) => i.id)
      ];
      if (toDelete.length > 0) {
        dispatch(LAYER_DELETE, { payload: { trackItemIds: toDelete } });
        await new Promise((r) => setTimeout(r, 150));
      }

      let cursor = alphaStartMs;

      const enrichedPairs = pairs.map((pair) => {
        const videoDurSec = pair.video ? getDurationFromUpload(pair.video) : 0;
        const audioDurSec = pair.audio ? getDurationFromUpload(pair.audio) : 0;
        return { ...pair, videoDurSec, audioDurSec };
      });

      for (const pair of enrichedPairs) {
        let pairDurMs: number;
        if (pair.audio) {
          pairDurMs = pair.audioDurSec > 0 ? pair.audioDurSec * 1000 : 5000;
        } else if (pair.video) {
          pairDurMs = pair.videoDurSec > 0 ? pair.videoDurSec * 1000 : 5000;
        } else {
          continue;
        }

        if (pair.video) {
          const { originalSrc, proxySrc } = resolvePromoUploadUrls(pair.video);
          const fileName = pair.video.fileName || pair.video.file?.name || "";
          const playbackRate =
            pair.audio && pair.videoDurSec > 0 && pair.audioDurSec > 0
              ? pair.videoDurSec / pair.audioDurSec
              : 1;
          const videoId = generateId();
          dispatch(ADD_VIDEO, {
            payload: {
              id: videoId,
              type: "video",
              display: { from: cursor, to: cursor + pairDurMs },
              playbackRate,
              details: {
                src: proxySrc,
                promoRole: "video",
                originalSrc,
                name: fileName,
                left: layout.left,
                top: layout.top,
                width: layout.width,
                height: layout.height,
                crop: { x: 0, y: 0, width: layout.width, height: layout.height }
              },
              metadata: { promoRole: "video", originalSrc, proxySrc }
            },
            options: { targetTrackId: "video", scaleMode: "fit" }
          });
          await new Promise((r) => setTimeout(r, 150));
          applyHoleLayoutAfterPromoAdd(videoId, layout);
        }

        if (pair.audio) {
          const { originalSrc, proxySrc } = resolvePromoUploadUrls(pair.audio);
          const fileName = pair.audio.fileName || pair.audio.file?.name || "";
          dispatch(ADD_AUDIO, {
            payload: {
              id: generateId(),
              type: "audio",
              display: { from: cursor, to: cursor + pairDurMs },
              details: {
                src: proxySrc,
                promoRole: "audio",
                originalSrc,
                name: fileName
              },
              metadata: { promoRole: "audio", originalSrc, proxySrc }
            },
            options: { targetTrackId: "audio" }
          });
          await new Promise((r) => setTimeout(r, 150));
        }

        cursor += pairDurMs;
      }

      // ── Loop/trim package & bg music to match total audio duration ──
      const totalAudioMs = cursor - alphaStartMs;
      if (totalAudioMs > 0) {
        await new Promise((r) => setTimeout(r, 200));
        const freshItems = useStore.getState().trackItemsMap || {};

        // -- Package: loop + trim or trim to fit --
        const pkgItems = getItemsForRole(freshItems, "package");
        if (pkgItems.length > 0) {
          const pkg = pkgItems[0] as any;
          const pkgDurMs =
            (pkg.display?.to ?? 0) - (pkg.display?.from ?? 0);
          const pkgTrimFrom = pkg.trim?.from ?? 0;
          const pkgTrimTo = pkg.trim?.to ?? pkgDurMs;
          const pkgMediaMs = pkgTrimTo - pkgTrimFrom;
          const pkgSrc = pkg.details?.src || "";

          if (pkgMediaMs > 0 && pkgSrc) {
            // Delete existing package(s)
            dispatch(LAYER_DELETE, {
              payload: { trackItemIds: pkgItems.map((i: any) => i.id) }
            });
            await new Promise((r) => setTimeout(r, 150));

            let pkgCursor = 0;
            let remaining = totalAudioMs;
            while (remaining > 0) {
              const segMs = Math.min(remaining, pkgMediaMs);
              dispatch(ADD_VIDEO, {
                payload: {
                  id: generateId(),
                  type: "video",
                  display: { from: pkgCursor, to: pkgCursor + segMs },
                  trim: { from: 0, to: segMs },
                  details: {
                    ...pkg.details,
                    promoRole: "package"
                  },
                  metadata: { ...pkg.metadata, promoRole: "package" }
                },
                options: { targetTrackId: "package", scaleMode: "fit" }
              });
              await new Promise((r) => setTimeout(r, 100));
              pkgCursor += segMs;
              remaining -= segMs;
            }
          }
        }

        // -- Background music: loop + trim or trim to fit --
        const bgItems = getItemsForRole(freshItems, "backgroundMusic");
        if (bgItems.length > 0) {
          const bg = bgItems[0] as any;
          const bgDurMs =
            (bg.display?.to ?? 0) - (bg.display?.from ?? 0);
          const bgTrimFrom = bg.trim?.from ?? 0;
          const bgTrimTo = bg.trim?.to ?? bgDurMs;
          const bgMediaMs = bgTrimTo - bgTrimFrom;
          const bgSrc = bg.details?.src || "";

          if (bgMediaMs > 0 && bgSrc) {
            // Delete existing bg music
            dispatch(LAYER_DELETE, {
              payload: { trackItemIds: bgItems.map((i: any) => i.id) }
            });
            await new Promise((r) => setTimeout(r, 150));

            let bgCursor = 0;
            let remaining = totalAudioMs;
            while (remaining > 0) {
              const segMs = Math.min(remaining, bgMediaMs);
              dispatch(ADD_AUDIO, {
                payload: {
                  id: generateId(),
                  type: "audio",
                  display: { from: bgCursor, to: bgCursor + segMs },
                  trim: { from: 0, to: segMs },
                  details: {
                    ...bg.details,
                    promoRole: "backgroundMusic"
                  },
                  metadata: { ...bg.metadata, promoRole: "backgroundMusic" }
                },
                options: { targetTrackId: "backgroundMusic" }
              });
              await new Promise((r) => setTimeout(r, 100));
              bgCursor += segMs;
              remaining -= segMs;
            }
          }
        }
      }

      // Sync the re-apply dedup key so the useEffect below doesn't immediately
      // re-trigger for the same set of pairs we just applied.
      prevPairsRef.current = pairs
        .map((p) => `${p.video?.id || ""}-${p.audio?.id || ""}`)
        .join(",");

      setAppliedToTimeline(true);
      toast.success("Assets applied to timeline.");
    } finally {
      setIsApplying(false);
    }
  }, [pairs, setAlphaInfo]);

  // Re-apply when order/matching changes after initial apply (debounced)
  const prevPairsRef = useRef<string>("");
  const reapplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyingRef = useRef(false);
  useEffect(() => {
    if (!appliedToTimeline || isUploading) return;
    const key = pairs.map((p) => `${p.video?.id || ""}-${p.audio?.id || ""}`).join(",");
    if (key === prevPairsRef.current) return;
    prevPairsRef.current = key;
    if (reapplyTimerRef.current) clearTimeout(reapplyTimerRef.current);
    reapplyTimerRef.current = setTimeout(async () => {
      if (applyingRef.current) return;
      applyingRef.current = true;
      try { await applyAllToTimeline(); } finally { applyingRef.current = false; }
    }, 500);
    return () => { if (reapplyTimerRef.current) clearTimeout(reapplyTimerRef.current); };
  }, [pairs, appliedToTimeline, isUploading]);

  // ── Render ────────────────────────────────────────────────────
  const hasAssets = assetVideos.length > 0 || assetAudios.length > 0;

  return (
    <div className="flex flex-1 flex-col h-full min-h-0 overflow-hidden">
      <ModalUpload type="all" role="asset" />

      <div className="flex items-center justify-center px-4 pt-4 pb-2">
        <Button
          className="w-full cursor-pointer"
          onClick={() => setShowUploadModal(true)}
          variant="outline"
        >
          <UploadIcon className="w-4 h-4" />
          <span className="ml-2">Upload Audio &amp; Video</span>
        </Button>
      </div>

      {isUploading && (
        <div className="px-4 pb-2 text-xs text-muted-foreground flex items-center gap-2">
          <div className="h-3 w-3 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
          Uploading...
        </div>
      )}

      {!hasAssets && !isUploading && (
        <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
          <VideoIcon size={32} className="opacity-50" />
          <span className="text-sm">No assets uploaded yet</span>
        </div>
      )}

      {hasAssets && (
        <>
          {pairs.length > 0 && !appliedToTimeline && (
            <div className="px-4 pb-2">
              <Button
                className="w-full cursor-pointer"
                onClick={applyAllToTimeline}
                disabled={isApplying || isUploading}
                variant="default"
                size="sm"
              >
                {isUploading
                  ? "Waiting for uploads..."
                  : isApplying
                    ? "Applying..."
                    : "Apply All to Timeline"}
              </Button>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto px-2">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={pairIds} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col gap-2 pb-4 px-2">
                  {pairs.map((pair) => (
                    <SortablePairRow
                      key={pair.id}
                      pair={pair}
                      thumbnails={thumbnails}
                      playingId={playingId}
                      setPlayingId={setPlayingId}
                      isDraggingSlot={!!activeSlotDrag}
                      onRemoveVideo={handleRemoveVideo}
                      onRemoveAudio={handleRemoveAudio}
                      setPickingSlot={setPickingSlot}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        </>
      )}

      {/* ── Upload-to-slot dialog ────────────────────────────── */}
      <SlotUploadDialog
        pickingSlot={pickingSlot}
        onClose={() => setPickingSlot(null)}
        onUploaded={(asset) => {
          if (pickingSlot) handleAssignToSlot(pickingSlot.pairId, pickingSlot.type, asset);
        }}
      />
    </div>
  );
}

// ── Upload-to-slot dialog ───────────────────────────────────────
function SlotUploadDialog({
  pickingSlot,
  onClose,
  onUploaded
}: {
  pickingSlot: { pairId: string; type: "video" | "audio" } | null;
  onClose: () => void;
  onUploaded: (asset: any) => void;
}) {
  const { setUploads } = useUploadStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const isVideo = pickingSlot?.type === "video";
  const accept = isVideo
    ? "video/*,.mov,.mxf,.avi,.wmv,.flv,.webm,.mkv,.m4v,.ts,.m2ts"
    : "audio/*,.wav,.aac,.flac,.ogg,.wma,.m4a";
  const label = isVideo ? "Video" : "Audio";

  useEffect(() => {
    if (!pickingSlot) {
      setSelectedFile(null);
      setUploading(false);
      setProgress(0);
    }
  }, [pickingSlot]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = "";
    if (file) setSelectedFile(file);
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setProgress(0);

    const uploadId = crypto.randomUUID();
    try {
      const result = await processUpload(
        uploadId,
        { file: selectedFile },
        {
          onProgress: (_id, p) => setProgress(p),
          onStatus: () => {}
        }
      );

      if (result) {
        const record = Array.isArray(result) ? result[0] : result;
        const tagged = {
          ...record,
          metadata: { ...(record.metadata || {}), promoRole: "asset" }
        };
        setUploads((prev: any[]) => [...prev, tagged]);
        setTimeout(() => onUploaded(tagged), 50);
      }
    } catch (err) {
      console.error("Slot upload failed:", err);
      toast.error("Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={!!pickingSlot} onOpenChange={(open) => { if (!open && !uploading) onClose(); }}>
      <DialogContent className="sm:max-w-sm" showCloseButton={!uploading}>
        <DialogHeader>
          <DialogTitle className="text-md">Upload {label}</DialogTitle>
        </DialogHeader>

        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          onChange={handleFileSelect}
          className="hidden"
        />

        <div className="space-y-4">
          <div
            className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer hover:border-muted-foreground/50 ${
              selectedFile ? "border-primary/30" : "border-border"
            }`}
            onClick={() => !uploading && fileInputRef.current?.click()}
          >
            {!selectedFile ? (
              <>
                <UploadIcon className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground mb-1">
                  Drag and drop file here, or
                </p>
                <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}>
                  browse files
                </Button>
              </>
            ) : (
              <div className="flex items-center gap-3 text-left">
                <div className="h-10 w-10 flex items-center justify-center rounded border bg-muted shrink-0">
                  {isVideo ? <VideoIcon size={18} /> : <Music2 size={18} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{selectedFile.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {selectedFile.size >= 1048576
                      ? `${(selectedFile.size / 1048576).toFixed(2)} MB`
                      : `${(selectedFile.size / 1024).toFixed(2)} KB`}
                  </p>
                </div>
              </div>
            )}
          </div>

          {uploading && (
            <div className="w-full bg-secondary rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-primary h-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onClose} disabled={uploading}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={handleUpload} disabled={!selectedFile || uploading}>
              {uploading ? `Uploading… ${progress}%` : "Upload"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Sortable pair row (handles pair reorder via grip) ──────────

function SortablePairRow({
  pair,
  thumbnails,
  playingId,
  setPlayingId,
  isDraggingSlot,
  onRemoveVideo,
  onRemoveAudio,
  setPickingSlot
}: {
  pair: AssetPair;
  thumbnails: Record<string, string>;
  playingId: string | null;
  setPlayingId: (id: string | null) => void;
  isDraggingSlot: boolean;
  onRemoveVideo: (pairId: string) => void;
  onRemoveAudio: (pairId: string) => void;
  setPickingSlot: (slot: { pairId: string; type: "video" | "audio" }) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: pair.id, disabled: isDraggingSlot });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : "auto"
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-stretch gap-2 rounded-md border border-border p-1.5">
      {/* Grip handle — reorders the pair */}
      <div
        className="flex items-center text-muted-foreground/40 cursor-grab active:cursor-grabbing touch-none"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </div>

      {/* Video slot — draggable to swap between pairs */}
      <DraggableVideoSlot
        pair={pair}
        thumbnails={thumbnails}
        onRemove={() => onRemoveVideo(pair.id)}
        onPickClick={() => setPickingSlot({ pairId: pair.id, type: "video" })}
      />

      {/* Audio slot — draggable to swap between pairs */}
      <DraggableAudioSlot
        pair={pair}
        playingId={playingId}
        setPlayingId={setPlayingId}
        onRemove={() => onRemoveAudio(pair.id)}
        onPickClick={() => setPickingSlot({ pairId: pair.id, type: "audio" })}
      />
    </div>
  );
}

// ── Draggable video slot ───────────────────────────────────────

function DraggableVideoSlot({
  pair,
  thumbnails,
  onRemove,
  onPickClick
}: {
  pair: AssetPair;
  thumbnails: Record<string, string>;
  onRemove: () => void;
  onPickClick: () => void;
}) {
  const id = videoSlotId(pair.id);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver
  } = useSortable({ id });

  const videoKey = pair.video?.id || pair.video?.fileName || "";
  const thumbSrc = thumbnails[videoKey] || "";
  const videoName = pair.video?.fileName || pair.video?.file?.name || "";
  const displayName = videoName.replace(/\.[^.]+$/, "");

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`w-[120px] shrink-0 cursor-grab active:cursor-grabbing touch-none rounded ${
        isOver ? "ring-2 ring-primary" : ""
      }`}
      {...attributes}
      {...listeners}
    >
      {pair.video ? (
        <div className="relative aspect-[4/3] rounded overflow-hidden bg-black group/vid">
          {thumbSrc ? (
            <img src={thumbSrc} alt={videoName} className="w-full h-full object-cover" />
          ) : (
            <div className="flex items-center justify-center w-full h-full">
              <VideoIcon size={20} className="text-muted-foreground" />
            </div>
          )}
          <button
            className="absolute right-1 top-1 z-10 h-6 w-6 rounded-full bg-red-600 text-white text-xs flex items-center justify-center opacity-0 group-hover/vid:opacity-100 transition"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            aria-label="Delete asset"
          >
            &#10005;
          </button>
          <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-1 py-0.5">
            <span className="text-[10px] text-white truncate block">
              {displayName.length > 18 ? displayName.substring(0, 18) + "..." : displayName}
            </span>
          </div>
        </div>
      ) : (
        <div
          className="aspect-[4/3] rounded border border-dashed border-muted-foreground/20 bg-muted/10 flex items-center justify-center cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition"
          onClick={(e) => { e.stopPropagation(); onPickClick(); }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <VideoIcon size={16} className="text-muted-foreground/30" />
        </div>
      )}
    </div>
  );
}

// ── Draggable audio slot ───────────────────────────────────────

function DraggableAudioSlot({
  pair,
  playingId,
  setPlayingId,
  onRemove,
  onPickClick
}: {
  pair: AssetPair;
  playingId: string | null;
  setPlayingId: (id: string | null) => void;
  onRemove: () => void;
  onPickClick: () => void;
}) {
  const id = audioSlotId(pair.id);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver
  } = useSortable({ id });

  const audioRef = useRef<HTMLAudioElement>(null);
  const [duration, setDuration] = useState("--:--");
  const audioId = pair.audio?.id || "";
  const isPlaying = playingId === audioId && !!audioId;

  useEffect(() => {
    if (isPlaying) audioRef.current?.play();
    else {
      audioRef.current?.pause();
      if (audioRef.current) audioRef.current.currentTime = 0;
    }
  }, [isPlaying]);

  const audioSrc = pair.audio
    ? pair.audio.metadata?.proxyUrl ||
      pair.audio.metadata?.uploadedUrl ||
      pair.audio.url ||
      pair.audio.details?.src ||
      ""
    : "";
  const audioName = pair.audio?.fileName || pair.audio?.file?.name || "";

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex-1 min-w-0 flex items-center cursor-grab active:cursor-grabbing touch-none rounded ${
        isOver ? "ring-2 ring-primary" : ""
      }`}
      {...attributes}
      {...listeners}
    >
      {pair.audio ? (
        <div className="relative flex items-center gap-2 w-full bg-secondary rounded-sm p-2 group/aud">
          <button
            className="absolute right-1 top-1 z-10 h-6 w-6 rounded-full bg-red-600 text-white text-xs flex items-center justify-center opacity-0 group-hover/aud:opacity-100 transition"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            aria-label="Delete asset"
          >
            &#10005;
          </button>
          <audio
            ref={audioRef}
            src={audioSrc}
            onEnded={() => setPlayingId(null)}
            onLoadedMetadata={() => {
              if (audioRef.current) {
                const s = Math.round(audioRef.current.duration);
                const m = Math.floor(s / 60);
                setDuration(`${m}:${(s % 60).toString().padStart(2, "0")}`);
              }
            }}
            className="hidden"
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 rounded-full bg-black/10 dark:bg-white/5 shrink-0"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setPlayingId(isPlaying ? null : audioId);
            }}
          >
            {isPlaying ? (
              <Pause className="size-3 fill-current" />
            ) : (
              <Play className="size-3 fill-current ml-0.5" />
            )}
          </Button>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[11px] font-medium truncate text-secondary-foreground">
              {audioName}
            </span>
            <span className="text-[10px] text-muted-foreground">{duration}</span>
          </div>
        </div>
      ) : (
        <div
          className="flex-1 flex items-center justify-center w-full h-full rounded border border-dashed border-muted-foreground/20 bg-muted/10 min-h-[40px] cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition"
          onClick={(e) => { e.stopPropagation(); onPickClick(); }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Music2 size={14} className="text-muted-foreground/30" />
        </div>
      )}
    </div>
  );
}
