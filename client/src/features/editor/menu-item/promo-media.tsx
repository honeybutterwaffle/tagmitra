import React, { useCallback, useMemo, useState } from "react";
import Draggable from "@/components/shared/draggable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dispatch } from "@designcombo/events";
import { ADD_AUDIO, ADD_IMAGE, ADD_VIDEO } from "@designcombo/state";
import { generateId } from "@designcombo/timeline";
import {
  Image as ImageIcon,
  Music2,
  Search,
  UploadIcon,
  Video as VideoIcon
} from "lucide-react";
import ModalUpload from "@/components/modal-upload";
import useUploadStore from "../store/use-upload-store";
import { useIsDraggingOverTimeline } from "../hooks/is-dragging-over-timeline";
import { AudioItem } from "./audio-item";
import useStore from "../store/use-store";
import { toast } from "sonner";
import {
  applyBackgroundMusicUploadToTimeline,
  applyHoleLayoutAfterPromoAdd,
  applyPackageUploadToTimeline,
  getItemsForRole,
  promoHoleLayoutFromAlpha,
  resolvePackageAlphaForPromo,
  resolvePromoUploadUrls
} from "../utils/promo-timeline-apply";

type Kind = "video" | "audio" | "image";

const BACKEND = "http://localhost:8000";

interface PromoMediaPickerProps {
  kind: Kind;
  role: string;
  title: string;
  uploadType?: "video" | "audio" | "image";
  allowMultiple?: boolean;
  trackId?: string;
  description?: string;
}

const typeFilters: Record<Kind, (type?: string) => boolean> = {
  video: (type) => Boolean(type?.startsWith("video/") || type === "video"),
  audio: (type) => Boolean(type?.startsWith("audio/") || type === "audio"),
  image: (type) => Boolean(type?.startsWith("image/") || type === "image")
};

// ── Filename token matching ─────────────────────────────────────
function stemTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1)
  );
}

function findMatchingUpload(
  uploads: any[],
  targetRole: string,
  sourceFileName: string
): any | null {
  const srcTokens = stemTokens(sourceFileName);
  if (srcTokens.size === 0) return null;
  let best: any = null;
  let bestScore = 0;
  for (const u of uploads.filter(
    (u) => u.metadata?.promoRole === targetRole
  )) {
    const uName = u.fileName || u.file?.name || "";
    const uTokens = stemTokens(uName);
    let score = 0;
    for (const t of srcTokens) {
      if (uTokens.has(t)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = u;
    }
  }
  return bestScore > 0 ? best : null;
}

// ── Probe cache: metadata is probed at upload time and stored in the
// upload record. These helpers check the cache first to avoid redundant
// /api/probe/* calls on every item selection.

const _probeCache = new Map<string, { duration_sec?: number; width?: number; height?: number; aspect?: number }>();

function cacheProbeFromUpload(upload: any): void {
  const m = upload?.metadata ?? {};
  const url = m.originalUrl || m.uploadedUrl || upload?.url || "";
  if (!url) return;
  const entry: Record<string, number> = {};
  if (m.duration_sec != null && m.duration_sec > 0) entry.duration_sec = m.duration_sec;
  if (m.width > 0 && m.height > 0) {
    entry.width = m.width;
    entry.height = m.height;
    entry.aspect = m.aspect || m.width / m.height;
  }
  if (Object.keys(entry).length > 0) _probeCache.set(url, entry);
}

async function fetchDuration(originalUrl: string): Promise<number> {
  const cached = _probeCache.get(originalUrl);
  if (cached?.duration_sec != null && cached.duration_sec > 0) return cached.duration_sec;
  try {
    const res = await fetch(`${BACKEND}/api/probe/duration`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: originalUrl })
    });
    const data = await res.json();
    const dur = data.duration_sec || 0;
    if (dur > 0) _probeCache.set(originalUrl, { ..._probeCache.get(originalUrl), duration_sec: dur });
    return dur;
  } catch {
    return 0;
  }
}

async function fetchMediaAspect(originalUrl: string): Promise<number | undefined> {
  const cached = _probeCache.get(originalUrl);
  if (cached?.aspect != null && cached.aspect > 0) return cached.aspect;
  try {
    const res = await fetch(`${BACKEND}/api/probe/dimensions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: originalUrl })
    });
    const data = await res.json();
    if (data.aspect && data.aspect > 0) {
      _probeCache.set(originalUrl, { ..._probeCache.get(originalUrl), width: data.width, height: data.height, aspect: data.aspect });
      return Number(data.aspect);
    }
    if (data.width > 0 && data.height > 0) {
      const a = data.width / data.height;
      _probeCache.set(originalUrl, { ..._probeCache.get(originalUrl), width: data.width, height: data.height, aspect: a });
      return a;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

// ── Timeline helpers ────────────────────────────────────────────
function getLatestEnd(items: any[]): number {
  let max = 0;
  for (const item of items) {
    const to = item?.display?.to ?? 0;
    if (to > max) max = to;
  }
  return max;
}

function isItemOnTimeline(
  trackItemsMap: Record<string, any>,
  role: string,
  fileName: string
): boolean {
  const tokens = stemTokens(fileName);
  if (tokens.size === 0) return false;
  for (const item of getItemsForRole(trackItemsMap, role)) {
    const name =
      item?.details?.name ||
      item?.details?.fileName ||
      item?.details?.src ||
      "";
    const itemTokens = stemTokens(name);
    let score = 0;
    for (const t of tokens) {
      if (itemTokens.has(t)) score++;
    }
    if (score > 0) return true;
  }
  return false;
}

export function PromoMediaPicker({
  kind,
  role,
  title,
  uploadType,
  allowMultiple = true,
  trackId,
  description
}: PromoMediaPickerProps) {
  const isDraggingOverTimeline = useIsDraggingOverTimeline();
  const [searchQuery, setSearchQuery] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const {
    uploads,
    setShowUploadModal,
    removeUploadAsset,
    pendingUploads,
    activeUploads
  } = useUploadStore();
  const { trackItemsMap, alphaInfo, setAlphaInfo } = useStore();

  // Pre-populate probe cache for all uploads on mount / store change
  useMemo(() => { for (const u of uploads) cacheProbeFromUpload(u); }, [uploads]);

  const existingForRole = useMemo(
    () => getItemsForRole(trackItemsMap || {}, role),
    [trackItemsMap, role]
  );

  const mediaUploads = useMemo(() => {
    const filtered = uploads.filter(
      (u) =>
        typeFilters[kind](u.type) &&
        (u.metadata?.promoRole ?? null) === role
    );
    // Populate probe cache from upload metadata so we never need /api/probe/* calls
    for (const u of filtered) cacheProbeFromUpload(u);
    return filtered;
  }, [uploads, kind, role]);

  const isLoading = useMemo(() => {
    return pendingUploads.length > 0 || activeUploads.length > 0;
  }, [pendingUploads, activeUploads]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return mediaUploads;
    return mediaUploads.filter((item) => {
      const name = (
        item.file?.name ||
        item.fileName ||
        item.url ||
        ""
      ).toLowerCase();
      return name.includes(searchQuery.toLowerCase());
    });
  }, [mediaUploads, searchQuery]);

  const resolveUrls = useCallback(
    (item: any) => resolvePromoUploadUrls(item),
    []
  );

  // ── Role-specific add logic ─────────────────────────────────
  const handleAdd = useCallback(
    async (item: any) => {
      const { originalSrc, proxySrc, fileName } = resolveUrls(item);
      const currentItems = useStore.getState().trackItemsMap || {};
      const currentAlpha = useStore.getState().alphaInfo;
      const allUploads = useUploadStore.getState().uploads;

      // ── PACKAGE ─────────────────────────────────────────────
      if (role === "package") {
        await applyPackageUploadToTimeline(item);
        return;
      }

      // ── BACKGROUND MUSIC ────────────────────────────────────
      if (role === "backgroundMusic") {
        applyBackgroundMusicUploadToTimeline(item);
        return;
      }

      // ── PROGRAM SLATE ───────────────────────────────────────
      if (role === "programSlate") {
        const pkgs = getItemsForRole(currentItems, "package");
        if (!pkgs.length) {
          toast.error("Add a package to the timeline first.", {
            description: "The slate is positioned inside the package alpha hole."
          });
          return;
        }

        const slateAspect =
          (await fetchMediaAspect(originalSrc)) ?? 16 / 9;
        const alphaResolved = await resolvePackageAlphaForPromo(
          currentItems,
          setAlphaInfo,
          slateAspect
        );
        if (!alphaResolved) {
          toast.error("Could not detect the package alpha hole.", {
            description:
              "Ensure the package shows a dark region and the render server has OpenCV installed."
          });
          return;
        }

        const layout = promoHoleLayoutFromAlpha(alphaResolved);
        if (!layout) {
          toast.error("Alpha detection returned no layout box.");
          return;
        }

        const alphaStartMs = (alphaResolved.startSec ?? 0) * 1000;
        const dur = await fetchDuration(originalSrc);
        const durMs = dur > 0 ? dur * 1000 : 5000;

        const itemId = generateId();
        const payload: any = {
          id: itemId,
          type: "video",
          display: { from: alphaStartMs, to: alphaStartMs + durMs },
          details: {
            src: proxySrc,
            promoRole: role,
            originalSrc,
            name: fileName,
            left: layout.left,
            top: layout.top,
            width: layout.width,
            height: layout.height,
            crop: {
              x: 0,
              y: 0,
              width: layout.width,
              height: layout.height
            }
          },
          metadata: { promoRole: role, originalSrc, proxySrc }
        };

        dispatch(ADD_VIDEO, {
          payload,
          options: { targetTrackId: "programSlate", scaleMode: "fit" }
        });
        applyHoleLayoutAfterPromoAdd(itemId, layout);
        return;
      }

      // ── SPONSOR AUDIO ───────────────────────────────────────
      if (role === "sponsorAudio") {
        let alphaForAudioTiming = currentAlpha;
        if (
          (alphaForAudioTiming?.startSec == null ||
            alphaForAudioTiming.startSec <= 0) &&
          getItemsForRole(currentItems, "package").length > 0
        ) {
          alphaForAudioTiming =
            (await resolvePackageAlphaForPromo(currentItems, setAlphaInfo)) ??
            alphaForAudioTiming;
        }

        const slateItems = getItemsForRole(currentItems, "programSlate");
        const audioItems = getItemsForRole(currentItems, "sponsorAudio");
        const slateEnd = getLatestEnd(slateItems);
        const audioEnd = getLatestEnd(audioItems);
        const alphaStartMs = (alphaForAudioTiming?.startSec ?? 0) * 1000;

        const startFrom = audioItems.length > 0
          ? audioEnd
          : Math.max(slateEnd, alphaStartMs);

        const dur = await fetchDuration(originalSrc);
        const durMs = dur > 0 ? dur * 1000 : 5000;

        dispatch(ADD_AUDIO, {
          payload: {
            id: generateId(),
            type: "audio",
            display: { from: startFrom, to: startFrom + durMs },
            details: {
              src: proxySrc,
              promoRole: role,
              originalSrc,
              name: fileName
            },
            metadata: { promoRole: role, originalSrc, proxySrc }
          },
          options: { targetTrackId: "sponsorAudio" }
        });

        // Auto-pair: find matching mute upload and add it
        const matchedMute = findMatchingUpload(allUploads, "mute", fileName);
        if (matchedMute) {
          const muteName = matchedMute.fileName || matchedMute.file?.name || "";
          if (!isItemOnTimeline(currentItems, "mute", muteName)) {
            const muteOriginal =
              matchedMute.metadata?.originalUrl ||
              matchedMute.metadata?.uploadedUrl ||
              matchedMute.url;
            const muteProxy =
              matchedMute.metadata?.proxyUrl ||
              matchedMute.metadata?.uploadedUrl ||
              matchedMute.url;

            const pkgs = getItemsForRole(currentItems, "package");
            if (!pkgs.length) {
              toast.error("Add a package first to position mute in the alpha hole.");
            } else {
              const muteAr =
                (await fetchMediaAspect(muteOriginal)) ?? 16 / 9;
              const alphaForMute = await resolvePackageAlphaForPromo(
                currentItems,
                setAlphaInfo,
                muteAr
              );
              const layoutMute = promoHoleLayoutFromAlpha(alphaForMute);
              if (!alphaForMute || !layoutMute) {
                toast.error("Could not detect the package alpha hole for mute.");
              } else {
                const muteItemId = generateId();
                const mutePayload: any = {
                  id: muteItemId,
                  type: "video",
                  display: { from: startFrom, to: startFrom + durMs },
                  details: {
                    src: muteProxy,
                    promoRole: "mute",
                    originalSrc: muteOriginal,
                    name: muteName,
                    left: layoutMute.left,
                    top: layoutMute.top,
                    width: layoutMute.width,
                    height: layoutMute.height,
                    crop: {
                      x: 0,
                      y: 0,
                      width: layoutMute.width,
                      height: layoutMute.height
                    }
                  },
                  metadata: {
                    promoRole: "mute",
                    originalSrc: muteOriginal,
                    proxySrc: muteProxy
                  }
                };

                dispatch(ADD_VIDEO, {
                  payload: mutePayload,
                  options: { targetTrackId: "mute", scaleMode: "fit" }
                });
                applyHoleLayoutAfterPromoAdd(muteItemId, layoutMute);
              }
            }
          }
        }
        return;
      }

      // ── MUTE ────────────────────────────────────────────────
      if (role === "mute") {
        const pkgsMute = getItemsForRole(currentItems, "package");
        if (!pkgsMute.length) {
          toast.error("Add a package to the timeline first.", {
            description: "Mute video is positioned inside the package alpha hole."
          });
          return;
        }

        const muteAspect =
          (await fetchMediaAspect(originalSrc)) ?? 16 / 9;
        const alphaResolvedMute = await resolvePackageAlphaForPromo(
          currentItems,
          setAlphaInfo,
          muteAspect
        );
        if (!alphaResolvedMute) {
          toast.error("Could not detect the package alpha hole.");
          return;
        }
        const layoutMuteMain = promoHoleLayoutFromAlpha(alphaResolvedMute);
        if (!layoutMuteMain) {
          toast.error("Alpha detection returned no layout box.");
          return;
        }

        const slateItems = getItemsForRole(currentItems, "programSlate");
        const muteItems = getItemsForRole(currentItems, "mute");
        const slateEnd = getLatestEnd(slateItems);
        const muteEnd = getLatestEnd(muteItems);
        const alphaStartMs = (alphaResolvedMute.startSec ?? 0) * 1000;

        const startFrom = muteItems.length > 0
          ? muteEnd
          : Math.max(slateEnd, alphaStartMs);

        const dur = await fetchDuration(originalSrc);
        const durMs = dur > 0 ? dur * 1000 : 5000;

        const muteItemIdMain = generateId();
        const payload: any = {
          id: muteItemIdMain,
          type: "video",
          display: { from: startFrom, to: startFrom + durMs },
          details: {
            src: proxySrc,
            promoRole: role,
            originalSrc,
            name: fileName,
            left: layoutMuteMain.left,
            top: layoutMuteMain.top,
            width: layoutMuteMain.width,
            height: layoutMuteMain.height,
            crop: {
              x: 0,
              y: 0,
              width: layoutMuteMain.width,
              height: layoutMuteMain.height
            }
          },
          metadata: { promoRole: role, originalSrc, proxySrc }
        };

        dispatch(ADD_VIDEO, {
          payload,
          options: { targetTrackId: "mute", scaleMode: "fit" }
        });
        applyHoleLayoutAfterPromoAdd(muteItemIdMain, layoutMuteMain);

        // Auto-pair: find matching audio upload and add it
        const matchedAudio = findMatchingUpload(
          allUploads,
          "sponsorAudio",
          fileName
        );
        if (matchedAudio) {
          const audioName =
            matchedAudio.fileName || matchedAudio.file?.name || "";
          if (!isItemOnTimeline(currentItems, "sponsorAudio", audioName)) {
            const audioOriginal =
              matchedAudio.metadata?.originalUrl ||
              matchedAudio.metadata?.uploadedUrl ||
              matchedAudio.url;
            const audioProxy =
              matchedAudio.metadata?.proxyUrl ||
              matchedAudio.metadata?.uploadedUrl ||
              matchedAudio.url;

            const audioDur = await fetchDuration(audioOriginal);
            const audioDurMs = audioDur > 0 ? audioDur * 1000 : durMs;

            dispatch(ADD_AUDIO, {
              payload: {
                id: generateId(),
                type: "audio",
                display: { from: startFrom, to: startFrom + audioDurMs },
                details: {
                  src: audioProxy,
                  promoRole: "sponsorAudio",
                  originalSrc: audioOriginal,
                  name: audioName
                },
                metadata: {
                  promoRole: "sponsorAudio",
                  originalSrc: audioOriginal,
                  proxySrc: audioProxy
                }
              },
              options: { targetTrackId: "sponsorAudio" }
            });
          }
        }
        return;
      }

      // ── OVERLAY ─────────────────────────────────────────────
      if (role === "overlay") {
        const pkgsOv = getItemsForRole(currentItems, "package");
        if (!pkgsOv.length) {
          toast.error("Add a package to the timeline first.", {
            description: "Overlay is positioned inside the package alpha hole."
          });
          return;
        }

        const imageAspect =
          (await fetchMediaAspect(originalSrc)) ?? 16 / 9;
        const alphaResolvedOv = await resolvePackageAlphaForPromo(
          currentItems,
          setAlphaInfo,
          imageAspect
        );
        if (!alphaResolvedOv) {
          toast.error("Could not detect the package alpha hole.");
          return;
        }
        const layoutOv = promoHoleLayoutFromAlpha(alphaResolvedOv);
        if (!layoutOv) {
          toast.error("Alpha detection returned no layout box.");
          return;
        }

        const videoItems = getItemsForRole(currentItems, "video");
        const alphaStartMs = (alphaResolvedOv.startSec ?? 0) * 1000;

        let fromMs = alphaStartMs;
        let toMs = alphaStartMs + 5000;
        if (videoItems.length > 0) {
          const videoStarts = videoItems.map(
            (m: any) => m?.display?.from ?? 0
          );
          fromMs = Math.min(...videoStarts);
          toMs = getLatestEnd(videoItems);
        }

        const overlayItemId = generateId();
        const payload: any = {
          id: overlayItemId,
          type: "image",
          display: { from: fromMs, to: toMs },
          details: {
            src: proxySrc,
            promoRole: role,
            originalSrc,
            name: fileName,
            left: layoutOv.left,
            top: layoutOv.top,
            width: layoutOv.width,
            height: layoutOv.height,
            crop: {
              x: 0,
              y: 0,
              width: layoutOv.width,
              height: layoutOv.height
            }
          },
          metadata: { promoRole: role, originalSrc, proxySrc }
        };

        dispatch(ADD_IMAGE, {
          payload,
          options: { targetTrackId: "overlay" }
        });
        applyHoleLayoutAfterPromoAdd(overlayItemId, layoutOv);
        return;
      }

      // ── FALLBACK (text, etc.) ───────────────────────────────
      if (kind === "video") {
        dispatch(ADD_VIDEO, {
          payload: {
            id: generateId(),
            type: "video",
            details: { src: proxySrc, promoRole: role, originalSrc },
            metadata: { promoRole: role, originalSrc, proxySrc }
          },
          options: { targetTrackId: trackId || role, scaleMode: "fit" }
        });
      } else if (kind === "audio") {
        dispatch(ADD_AUDIO, {
          payload: {
            id: generateId(),
            type: "audio",
            details: { src: proxySrc, promoRole: role, originalSrc },
            metadata: { promoRole: role, originalSrc, proxySrc }
          },
          options: { targetTrackId: trackId || role }
        });
      } else if (kind === "image") {
        dispatch(ADD_IMAGE, {
          payload: {
            id: generateId(),
            type: "image",
            display: { from: 0, to: 5000 },
            details: { src: proxySrc, promoRole: role, originalSrc },
            metadata: { promoRole: role, originalSrc, proxySrc }
          },
          options: { targetTrackId: trackId || role }
        });
      }
    },
    [role, kind, trackId, resolveUrls, setAlphaInfo]
  );

  // ── UI components ───────────────────────────────────────────

  const UploadPrompt = () => (
    <div className="flex items-center justify-center px-4 pt-4 pb-2">
      <Button
        className="w-full cursor-pointer"
        onClick={() => setShowUploadModal(true)}
        variant={"outline"}
      >
        <UploadIcon className="w-4 h-4" />
        <span className="ml-2">{`Upload ${title}`}</span>
      </Button>
    </div>
  );

  const EmptyState = () => {
    const Icon =
      kind === "video" ? VideoIcon : kind === "audio" ? Music2 : ImageIcon;
    return (
      <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
        <Icon size={32} className="opacity-50" />
        <span className="text-sm">{`No ${title.toLowerCase()} uploaded yet`}</span>
      </div>
    );
  };

  const NoResultsState = () => (
    <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
      <Search size={32} className="opacity-50" />
      <span className="text-sm">No matches found</span>
    </div>
  );

  return (
    <div className="flex flex-1 flex-col h-full min-h-0 overflow-hidden">
      <ModalUpload type={uploadType || kind} role={role} />
      <UploadPrompt />
      {isLoading && (
        <div className="px-4 pb-2 text-xs text-muted-foreground flex items-center gap-2">
          <div className="h-3 w-3 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
          Uploading...
        </div>
      )}

      <div className="px-4 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Button
              size="sm"
              variant="ghost"
              className="absolute left-1 top-1/2 h-6 w-6 -translate-y-1/2 p-0"
            >
              <Search className="h-3 w-3" />
            </Button>
            <Input
              placeholder={`Search ${title.toLowerCase()}...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          {searchQuery && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSearchQuery("")}
            >
              Clear
            </Button>
          )}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground leading-snug">
            {description}
          </p>
        )}
        {!allowMultiple && existingForRole.length > 0 && (
          <p className="text-[11px] text-amber-500">
            A {title.toLowerCase()} is already placed. Adding a new one will
            replace it.
          </p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4">
        {filtered.length === 0 && !searchQuery ? (
          <EmptyState />
        ) : filtered.length === 0 && searchQuery ? (
          <NoResultsState />
        ) : kind === "audio" ? (
          <div className="flex flex-col gap-2 pb-4">
            {filtered.map((audio, index) => {
              const mappedAudio = {
                id: audio.id || String(index),
                name: audio.file?.name || audio.fileName || title,
                details: {
                  src: audio.metadata?.uploadedUrl || audio.url
                },
                metadata: { promoRole: role }
              };
              const removeKey =
                audio.id ||
                audio.filePath ||
                audio.metadata?.uploadedUrl ||
                audio.metadata?.proxyUrl ||
                audio.url;

              return (
                <div className="relative group" key={mappedAudio.id}>
                  <button
                    className="absolute right-1 top-1 z-10 h-6 w-6 rounded-full bg-red-600 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeKey && removeUploadAsset(removeKey);
                    }}
                    aria-label="Delete asset"
                  >
                    &#10005;
                  </button>
                  <AudioItem
                    onAdd={() => handleAdd(audio)}
                    item={mappedAudio}
                    playingId={playingId}
                    setPlayingId={setPlayingId}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2 pb-4">
            {filtered.map((media, index) => {
              const previewSrc = media.metadata?.uploadedUrl || media.url;
              const name = media.file?.name || media.fileName || title;
              const style = {
                backgroundImage: `url(${previewSrc})`,
                backgroundSize: "cover",
                width: "80px",
                height: "80px"
              } as React.CSSProperties;
              const removeKey =
                media.id ||
                media.filePath ||
                media.metadata?.uploadedUrl ||
                media.metadata?.proxyUrl ||
                media.url;
              return (
                <div className="relative group" key={media.id || index}>
                  <button
                    className="absolute right-1 top-1 z-10 h-6 w-6 rounded-full bg-red-600 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeKey && removeUploadAsset(removeKey);
                    }}
                    aria-label="Delete asset"
                  >
                    &#10005;
                  </button>
                  <Draggable
                    data={{
                      ...media,
                      metadata: {
                        ...media.metadata,
                        previewUrl: previewSrc,
                        promoRole: role
                      },
                      details: {
                        ...(media.details || {}),
                        promoRole: role
                      }
                    }}
                    renderCustomPreview={
                      <div style={style} className="draggable" />
                    }
                    shouldDisplayPreview={!isDraggingOverTimeline}
                  >
                    <div
                      onClick={() => handleAdd(media)}
                      className="relative aspect-square flex w-full items-center justify-center overflow-hidden bg-background pb-2 group cursor-pointer border rounded-md"
                    >
                      {kind === "video" ? (
                        <video
                          draggable={false}
                          src={previewSrc}
                          className="h-full w-full object-cover"
                          preload="metadata"
                          muted
                        />
                      ) : (
                        <img
                          draggable={false}
                          src={previewSrc}
                          className="h-full w-full object-cover"
                          alt={name}
                        />
                      )}
                      <div className="absolute inset-0 flex flex-col justify-end p-2 bg-gradient-to-t from-black/60 to-transparent">
                        <div className="text-[10px] text-white truncate max-w-full">
                          {name}
                        </div>
                      </div>
                    </div>
                  </Draggable>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Exported menu components ──────────────────────────────────

export const PackageMenu = () => (
  <PromoMediaPicker
    kind="video"
    role="package"
    title="Package"
    allowMultiple={false}
    trackId="package"
    description="One package video; replacing it keeps duration, volume, opacity, speed, trim, and effects—only the media file changes."
  />
);

export const BackgroundMusicMenu = () => (
  <PromoMediaPicker
    kind="audio"
    role="backgroundMusic"
    title="Background Music"
    allowMultiple={false}
    trackId="backgroundMusic"
    description="One background track; uploading or adding a new file replaces the previous and keeps volume, speed, and timing if it was on the timeline."
  />
);

export const ProgramSlateMenu = () => (
  <PromoMediaPicker
    kind="video"
    role="programSlate"
    title="Program Slate"
    trackId="programSlate"
    description="Slate video that starts at the alpha box appearance."
  />
);

export const AudioMenu = () => (
  <PromoMediaPicker
    kind="audio"
    role="sponsorAudio"
    title="Audio"
    trackId="sponsorAudio"
    description="Sponsor audios placed sequentially after the slate. Matching mute is added automatically."
  />
);

export const MuteMenu = () => (
  <PromoMediaPicker
    kind="video"
    role="mute"
    title="Mute"
    trackId="mute"
    description="Video paired with sponsor audio, placed inside the alpha box. Matching audio is added automatically."
  />
);

export const OverlayMenu = () => (
  <PromoMediaPicker
    kind="image"
    role="overlay"
    title="Overlay"
    trackId="overlay"
    description="Image overlays placed within the alpha box area."
  />
);
