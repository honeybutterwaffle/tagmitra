import { create } from "zustand";
import { persist } from "zustand/middleware";
import { processUpload, type UploadCallbacks } from "@/utils/upload-service";
import {
  applyBackgroundMusicUploadToTimeline,
  applyPackageUploadToTimeline
} from "../utils/promo-timeline-apply";

interface UploadFile {
  id: string;
  file?: File;
  url?: string;
  type?: string;
  status?: "pending" | "uploading" | "uploaded" | "failed";
  progress?: number;
  error?: string;
}

interface IUploadStore {
  showUploadModal: boolean;
  setShowUploadModal: (showUploadModal: boolean) => void;
  uploadRole: string | null;
  setUploadRole: (role: string | null) => void;
  uploadProgress: Record<string, number>;
  setUploadProgress: (uploadProgress: Record<string, number>) => void;
  uploadsVideos: any[];
  setUploadsVideos: (uploadsVideos: any[]) => void;
  uploadsAudios: any[];
  setUploadsAudios: (uploadsAudios: any[]) => void;
  uploadsImages: any[];
  setUploadsImages: (uploadsImages: any[]) => void;
  files: UploadFile[];
  setFiles: (
    files: UploadFile[] | ((prev: UploadFile[]) => UploadFile[])
  ) => void;

  pendingUploads: UploadFile[];
  addPendingUploads: (uploads: UploadFile[]) => void;
  clearPendingUploads: () => void;
  activeUploads: UploadFile[];
  processUploads: () => void;
  updateUploadProgress: (id: string, progress: number) => void;
  setUploadStatus: (
    id: string,
    status: UploadFile["status"],
    error?: string
  ) => void;
  removeUpload: (id: string) => void;
  uploads: any[];
  setUploads: (uploads: any[] | ((prev: any[]) => any[])) => void;
  removeUploadAsset: (key: string) => void;
}

const useUploadStore = create<IUploadStore>()(
  persist(
    (set, get) => ({
      showUploadModal: false,
      setShowUploadModal: (showUploadModal: boolean) =>
        set({ showUploadModal }),
      uploadRole: null,
      setUploadRole: (uploadRole: string | null) => set({ uploadRole }),

      uploadProgress: {},
      setUploadProgress: (uploadProgress: Record<string, number>) =>
        set({ uploadProgress }),

      uploadsVideos: [],
      setUploadsVideos: (uploadsVideos: any[]) => set({ uploadsVideos }),

      uploadsAudios: [],
      setUploadsAudios: (uploadsAudios: any[]) => set({ uploadsAudios }),

      uploadsImages: [],
      setUploadsImages: (uploadsImages: any[]) => set({ uploadsImages }),

      files: [],
      setFiles: (
        files: UploadFile[] | ((prev: UploadFile[]) => UploadFile[])
      ) =>
        set((state) => ({
          files:
            typeof files === "function"
              ? (files as (prev: UploadFile[]) => UploadFile[])(state.files)
              : files
        })),

      pendingUploads: [],
      addPendingUploads: (uploads: UploadFile[]) => {
        set((state) => ({
          pendingUploads: [...state.pendingUploads, ...uploads]
        }));
      },
      clearPendingUploads: () => set({ pendingUploads: [] }),

      activeUploads: [],
      processUploads: () => {
        const {
          pendingUploads,
          activeUploads,
          updateUploadProgress,
          setUploadStatus,
          removeUpload,
          setUploads,
          uploadRole
        } = get();

        // Move pending uploads to active with 'uploading' status
        if (pendingUploads.length > 0) {
          set((state) => ({
            activeUploads: [
              ...state.activeUploads,
              ...pendingUploads.map((u) => ({
                ...u,
                status: "uploading" as const,
                progress: 0
              }))
            ],
            pendingUploads: []
          }));
        }

        // Get updated activeUploads after moving pending ones
        const currentActiveUploads = get().activeUploads;

        const callbacks: UploadCallbacks = {
          onProgress: (uploadId, progress) => {
            updateUploadProgress(uploadId, progress);
          },
          onStatus: (uploadId, status, error) => {
            setUploadStatus(uploadId, status, error);
            if (status === "uploaded") {
              // Remove from active uploads after a delay to show final status
              setTimeout(() => removeUpload(uploadId), 3000);
            } else if (status === "failed") {
              // Remove from active uploads after a delay to show final status
              setTimeout(() => removeUpload(uploadId), 3000);
            }
          }
        };

        // Process all uploading items
        for (const upload of currentActiveUploads.filter(
          (upload) => upload.status === "uploading"
        )) {
          console.log("upload", upload);
          processUpload(
            upload.id,
            { file: upload.file, url: upload.url },
            callbacks
          )
            .then((uploadData) => {
              // Add the complete upload data to the uploads array
              if (uploadData) {
                const tagRole = uploadRole ?? null;
                const tag = (u: any) => ({
                  ...u,
                  metadata: { ...(u.metadata || {}), promoRole: tagRole }
                });
                const singleRoleReplace =
                  tagRole === "package" || tagRole === "backgroundMusic";

                const applyTimelineIfPromo = (record: any) => {
                  if (tagRole === "package") {
                    void applyPackageUploadToTimeline(record);
                  } else if (tagRole === "backgroundMusic") {
                    applyBackgroundMusicUploadToTimeline(record);
                  }
                };

                if (Array.isArray(uploadData)) {
                  const tagged = uploadData.map(tag);
                  setUploads((prev) => {
                    if (!singleRoleReplace) return [...prev, ...tagged];
                    return [
                      ...prev.filter(
                        (u) => (u.metadata?.promoRole ?? null) !== tagRole
                      ),
                      ...tagged
                    ];
                  });
                  if (singleRoleReplace && tagged.length > 0) {
                    applyTimelineIfPromo(tagged[tagged.length - 1]);
                  }
                } else {
                  const one = tag(uploadData);
                  setUploads((prev) => {
                    if (!singleRoleReplace) return [...prev, one];
                    return [
                      ...prev.filter(
                        (u) => (u.metadata?.promoRole ?? null) !== tagRole
                      ),
                      one
                    ];
                  });
                  if (singleRoleReplace) {
                    applyTimelineIfPromo(one);
                  }
                }
              }
            })
            .catch((error) => {
              console.error("Upload failed:", error);
            });
        }
      },
      updateUploadProgress: (id: string, progress: number) =>
        set((state) => ({
          activeUploads: state.activeUploads.map((u) =>
            u.id === id ? { ...u, progress } : u
          )
        })),
      setUploadStatus: (
        id: string,
        status: UploadFile["status"],
        error?: string
      ) =>
        set((state) => ({
          activeUploads: state.activeUploads.map((u) =>
            u.id === id ? { ...u, status, error } : u
          )
        })),
      removeUpload: (id: string) =>
        set((state) => ({
          activeUploads: state.activeUploads.filter((u) => u.id !== id)
        })),
      uploads: [],
      setUploads: (uploads: any[] | ((prev: any[]) => any[])) =>
        set((state) => ({
          uploads:
            typeof uploads === "function"
              ? (uploads as (prev: any[]) => any[])(state.uploads)
              : uploads
        })),
      removeUploadAsset: (key: string) =>
        set((state) => ({
          uploads: state.uploads.filter(
            (u) =>
              u.id !== key &&
              u.filePath !== key &&
              u.metadata?.uploadedUrl !== key &&
              u.metadata?.proxyUrl !== key &&
              u.metadata?.originalUrl !== key &&
              u.url !== key
          )
        }))
    }),
    {
      name: "upload-store",
      partialize: (state) => ({ uploads: state.uploads })
    }
  )
);

export type { UploadFile };
export default useUploadStore;
