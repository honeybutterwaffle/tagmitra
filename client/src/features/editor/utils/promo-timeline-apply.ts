import { dispatch } from "@designcombo/events";
import {
  ADD_AUDIO,
  ADD_VIDEO,
  DESIGN_RESIZE,
  EDIT_OBJECT,
  LAYER_DELETE
} from "@designcombo/state";
import { generateId } from "@designcombo/timeline";
import useStore, { type IAlphaInfo } from "../store/use-store";
import { getEditorStateManager } from "./editor-state-manager";

const BACKEND = "http://localhost:8000";

function getTrackItemsMap(): Record<string, any> {
  const sm = getEditorStateManager();
  if (sm) return sm.getState().trackItemsMap || {};
  return useStore.getState().trackItemsMap || {};
}

/** Deep snapshot so LAYER_DELETE / Immer cannot clear fields we still need for merge. */
function cloneTimelineItem(item: any): any {
  if (!item) return item;
  try {
    return JSON.parse(JSON.stringify(item));
  } catch {
    return {
      ...item,
      details: item.details ? { ...item.details } : {},
      metadata: item.metadata ? { ...item.metadata } : {},
      display: item.display ? { ...item.display } : undefined,
      trim: item.trim ? { ...item.trim } : undefined,
      modifier: item.modifier ? { ...item.modifier } : undefined
    };
  }
}

export function getItemsForRole(
  trackItemsMap: Record<string, any>,
  role: string
): any[] {
  return Object.values(trackItemsMap).filter(
    (item: any) =>
      item?.metadata?.promoRole === role || item?.details?.promoRole === role
  );
}

/** Do not copy these from the old clip — new media supplies them. */
const MEDIA_IDENTITY_DETAIL_KEYS = new Set([
  "src",
  "originalSrc",
  "alphaProxySrc",
  "name",
  "promoRole",
  "frames",
  "stream",
  "blob"
]);

function mergeDetailsForMediaReplace(prevD: any, nextD: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(prevD || {})) {
    if (MEDIA_IDENTITY_DETAIL_KEYS.has(k)) continue;
    out[k] = prevD[k];
  }
  Object.assign(out, nextD || {});
  return out;
}

/** When replacing package / background music, keep timeline settings (duration, volume, opacity, trim, animations, etc.) */
export function mergeTimelineItemPreserveSettings(
  prev: any | undefined,
  nextPayload: any
): any {
  if (!prev) return nextPayload;
  const prevSnap = cloneTimelineItem(prev);
  const pD = prevSnap.details || {};
  const nD = nextPayload.details || {};
  return {
    ...nextPayload,
    name:
      nextPayload.name ??
      prevSnap.name ??
      prevSnap.details?.name ??
      nD.name,
    display:
      prevSnap.display != null ? { ...prevSnap.display } : nextPayload.display,
    trim: prevSnap.trim != null ? { ...prevSnap.trim } : nextPayload.trim,
    playbackRate: prevSnap.playbackRate ?? nextPayload.playbackRate,
    animations: prevSnap.animations ?? nextPayload.animations,
    modifier:
      prevSnap.modifier != null
        ? { ...prevSnap.modifier }
        : nextPayload.modifier,
    details: mergeDetailsForMediaReplace(pD, nD),
    metadata: {
      ...(prevSnap.metadata || {}),
      ...(nextPayload.metadata || {})
    }
  };
}

/** Styling / layout details to re-apply if add handlers drop them. */
function preservedDetailPatchFromPrev(prevSnap: any): Record<string, unknown> {
  const d = prevSnap?.details;
  if (!d || typeof d !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(d)) {
    if (MEDIA_IDENTITY_DETAIL_KEYS.has(k)) continue;
    const v = d[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * EDIT_OBJECT runs only after the new item exists — microtask is too early
 * (add handlers are async) and would read undefined.details inside state.
 */
function reinforcePreservedStateAfterAdd(
  newItemId: string | undefined,
  prevSnap: any | undefined
): void {
  if (!newItemId || !prevSnap) return;
  const details = preservedDetailPatchFromPrev(prevSnap);
  const playbackRate = prevSnap.playbackRate;
  const hasDetails = Object.keys(details).length > 0;
  const hasRate =
    playbackRate !== undefined &&
    playbackRate !== null &&
    !Number.isNaN(playbackRate);
  if (!hasDetails && !hasRate) return;

  const deadline = Date.now() + 3000;
  const tick = () => {
    const item = getTrackItemsMap()[newItemId];
    if (item) {
      try {
        const entry: Record<string, unknown> = {};
        if (hasDetails) entry.details = details;
        if (hasRate) entry.playbackRate = playbackRate;
        dispatch(EDIT_OBJECT, { payload: { [newItemId]: entry } });
      } catch (e) {
        console.error("[promo-timeline] reinforce EDIT_OBJECT failed", e);
      }
      return;
    }
    if (Date.now() < deadline) {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);
}

export function resolvePromoUploadUrls(item: any): {
  originalSrc: string;
  proxySrc: string;
  alphaProxySrc: string;
  fileName: string;
} {
  const m = item.metadata ?? {};
  const d = item.details ?? {};
  const originalSrc =
    m.originalUrl || m.originalSrc || m.uploadedUrl ||
    d.originalSrc || item.url || d.src || "";
  const proxySrc =
    m.proxyUrl || m.proxySrc || m.uploadedUrl ||
    d.src || item.url || "";
  const alphaProxySrc =
    m.alphaProxyUrl || m.alphaProxySrc || d.alphaProxySrc || "";
  const fileName = item.fileName || item.file?.name || d.name || "";
  return { originalSrc, proxySrc, alphaProxySrc, fileName };
}

function isFiniteHoleBox(box: {
  left?: unknown;
  top?: unknown;
  width?: unknown;
  height?: unknown;
}): box is { left: number; top: number; width: number; height: number } {
  return (
    typeof box.left === "number" &&
    typeof box.top === "number" &&
    typeof box.width === "number" &&
    typeof box.height === "number" &&
    Number.isFinite(box.left) &&
    Number.isFinite(box.top) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0
  );
}

export function promoHoleLayoutFromAlpha(alpha: IAlphaInfo | null): {
  left: number;
  top: number;
  width: number;
  height: number;
} | null {
  if (!alpha) return null;
  if (
    alpha.slateFit &&
    alpha.slateFit.width > 0 &&
    alpha.slateFit.height > 0
  ) {
    return {
      left: alpha.slateFit.left,
      top: alpha.slateFit.top,
      width: alpha.slateFit.width,
      height: alpha.slateFit.height,
    };
  }
  if (
    typeof alpha.w === "number" &&
    typeof alpha.h === "number" &&
    alpha.w > 0 &&
    alpha.h > 0
  ) {
    return { left: alpha.x, top: alpha.y, width: alpha.w, height: alpha.h };
  }
  return null;
}

/**
 * ADD_VIDEO with scaleMode "fit" overwrites width/height with probed media size.
 * Re-apply hole box + reset transform after the item exists in state.
 */
/** Re-apply layout for video or image after ADD_* (designcombo may overwrite dimensions). */
export function applyHoleLayoutAfterPromoAdd(
  itemId: string | undefined,
  layout: { left: number; top: number; width: number; height: number }
): void {
  if (!itemId) return;
  if (
    !layout ||
    !Number.isFinite(layout.left) ||
    !Number.isFinite(layout.top) ||
    !Number.isFinite(layout.width) ||
    !Number.isFinite(layout.height) ||
    layout.width <= 0 ||
    layout.height <= 0
  ) {
    return;
  }
  const deadline = Date.now() + 3000;
  const tick = () => {
    const item = getTrackItemsMap()[itemId];
    if (item) {
      try {
        dispatch(EDIT_OBJECT, {
          payload: {
            [itemId]: {
              details: {
                left: layout.left,
                top: layout.top,
                width: layout.width,
                height: layout.height,
                transform: "none",
                crop: {
                  x: 0,
                  y: 0,
                  width: layout.width,
                  height: layout.height
                }
              }
            }
          }
        });
      } catch (e) {
        console.error("[promo-timeline] applyHoleLayoutAfterPromoAdd failed", e);
      }
      return;
    }
    if (Date.now() < deadline) {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);
}

export async function fetchAlphaInfo(
  originalUrl: string,
  options?: { sourceAspect?: number }
): Promise<{
  alpha: IAlphaInfo | null;
  resolution: { width: number; height: number };
}> {
  try {
    const body: Record<string, unknown> = { url: originalUrl };
    if (
      options?.sourceAspect != null &&
      Number.isFinite(options.sourceAspect) &&
      options.sourceAspect > 0
    ) {
      body.source_aspect = options.sourceAspect;
    }
    const res = await fetch(`${BACKEND}/api/analyze/alpha`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.alpha)
      return {
        alpha: null,
        resolution: data.resolution || { width: 0, height: 0 }
      };
    const sf = data.slate_fit;
    const slateFit =
      sf && isFiniteHoleBox(sf)
        ? {
            left: sf.left,
            top: sf.top,
            width: sf.width,
            height: sf.height
          }
        : undefined;
    return {
      alpha: {
        x: data.alpha.x,
        y: data.alpha.y,
        w: data.alpha.w,
        h: data.alpha.h,
        startSec: data.alpha.start_sec,
        pkgW: data.resolution?.width || 0,
        pkgH: data.resolution?.height || 0,
        ...(slateFit ? { slateFit } : {})
      },
      resolution: data.resolution || { width: 0, height: 0 }
    };
  } catch (e) {
    console.error("[alpha] detection failed:", e);
    return { alpha: null, resolution: { width: 0, height: 0 } };
  }
}

/**
 * Try package URLs in order — proxy is usually the render-server uploads URL;
 * original may be a host/path the server could not map until resolution was fixed.
 */
async function fetchAlphaInfoFirstWorking(
  urls: (string | undefined)[],
  options?: { sourceAspect?: number }
): Promise<{
  alpha: IAlphaInfo | null;
  resolution: { width: number; height: number };
}> {
  const seen = new Set<string>();
  let last: Awaited<ReturnType<typeof fetchAlphaInfo>> = {
    alpha: null,
    resolution: { width: 0, height: 0 }
  };
  for (const u of urls) {
    if (!u || typeof u !== "string" || !u.trim() || seen.has(u)) continue;
    seen.add(u);
    last = await fetchAlphaInfo(u, options);
    if (last.alpha) return last;
  }
  return last;
}

/**
 * Load alpha from the package on the timeline (for slate/mute if store is stale or empty).
 */
let _lastAlphaPkgSrc: string | null = null;

export async function resolvePackageAlphaForPromo(
  trackItemsMap: Record<string, any>,
  setAlphaInfo: (a: IAlphaInfo | null) => void,
  sourceAspect?: number
): Promise<IAlphaInfo | null> {
  const pkgs = getItemsForRole(trackItemsMap, "package");
  if (!pkgs.length) {
    return useStore.getState().alphaInfo;
  }
  const { originalSrc, proxySrc } = resolvePromoUploadUrls(pkgs[0]);
  const pkgKey = originalSrc || proxySrc || "";

  // Return cached alpha if the package hasn't changed
  const cached = useStore.getState().alphaInfo;
  if (cached && cached.w > 0 && cached.h > 0 && _lastAlphaPkgSrc === pkgKey) {
    return cached;
  }

  const ar =
    sourceAspect != null && Number.isFinite(sourceAspect) && sourceAspect > 0
      ? sourceAspect
      : 16 / 9;
  const { alpha } = await fetchAlphaInfoFirstWorking(
    [originalSrc, proxySrc],
    { sourceAspect: ar }
  );
  if (alpha) {
    _lastAlphaPkgSrc = pkgKey;
    setAlphaInfo(alpha);
    return alpha;
  }
  _lastAlphaPkgSrc = null;
  setAlphaInfo(null);
  return null;
}

export async function applyPackageUploadToTimeline(item: any): Promise<void> {
  const { originalSrc, proxySrc, alphaProxySrc, fileName } = resolvePromoUploadUrls(item);
  const currentItems = getTrackItemsMap();
  const existing = getItemsForRole(currentItems, "package");
  const prevPkgSnapshot = existing[0] ? cloneTimelineItem(existing[0]) : undefined;
  if (existing.length > 0) {
    dispatch(LAYER_DELETE, {
      payload: { trackItemIds: existing.map((i: any) => i.id) }
    });
  }

  const basePayload = {
    id: prevPkgSnapshot?.id ?? generateId(),
    type: "video",
    details: {
      src: proxySrc,
      promoRole: "package",
      ...(alphaProxySrc ? { alphaProxySrc } : {}),
      originalSrc,
      name: fileName
    },
    metadata: { promoRole: "package", originalSrc, proxySrc, alphaProxySrc }
  };
  const payload = mergeTimelineItemPreserveSettings(prevPkgSnapshot, basePayload);

  dispatch(ADD_VIDEO, {
    payload,
    options: { targetTrackId: "package", scaleMode: "fit" }
  });
  reinforcePreservedStateAfterAdd(payload.id, prevPkgSnapshot);

  // New package — invalidate cache so next resolvePackageAlphaForPromo re-fetches
  _lastAlphaPkgSrc = null;

  const { alpha, resolution } = await fetchAlphaInfoFirstWorking([
    originalSrc,
    proxySrc
  ]);
  _lastAlphaPkgSrc = alpha ? (originalSrc || proxySrc || "") : null;
  useStore.getState().setAlphaInfo(alpha);
  if (resolution.width && resolution.height) {
    dispatch(DESIGN_RESIZE, {
      payload: { width: resolution.width, height: resolution.height }
    });
  }
}

export function applyBackgroundMusicUploadToTimeline(item: any): void {
  const { originalSrc, proxySrc, fileName } = resolvePromoUploadUrls(item);
  const currentItems = getTrackItemsMap();
  const existingBg = getItemsForRole(currentItems, "backgroundMusic");
  const prevBgSnapshot = existingBg[0]
    ? cloneTimelineItem(existingBg[0])
    : undefined;
  if (existingBg.length > 0) {
    dispatch(LAYER_DELETE, {
      payload: { trackItemIds: existingBg.map((i: any) => i.id) }
    });
  }

  const basePayload = {
    id: prevBgSnapshot?.id ?? generateId(),
    type: "audio",
    details: {
      src: proxySrc,
      promoRole: "backgroundMusic",
      originalSrc,
      name: fileName
    },
    metadata: { promoRole: "backgroundMusic", originalSrc, proxySrc }
  };
  const payload = mergeTimelineItemPreserveSettings(prevBgSnapshot, basePayload);

  dispatch(ADD_AUDIO, {
    payload,
    options: { targetTrackId: "backgroundMusic" }
  });
  reinforcePreservedStateAfterAdd(payload.id, prevBgSnapshot);
}
