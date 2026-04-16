import Draggable from "@/components/shared/draggable";
import { dispatch } from "@designcombo/events";
import { ADD_VIDEO } from "@designcombo/state";
import { generateId } from "@designcombo/timeline";
import { IVideo } from "@designcombo/types";
import React, { useState } from "react";
import { useIsDraggingOverTimeline } from "../hooks/is-dragging-over-timeline";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Loader2, PlusIcon, UploadIcon, Video as VideoIcon } from "lucide-react";
import useUploadStore from "../store/use-upload-store";
import ModalUpload from "@/components/modal-upload";

export const Videos = () => {
  const isDraggingOverTimeline = useIsDraggingOverTimeline();
  const [searchQuery, setSearchQuery] = useState("");
  const { setShowUploadModal, uploads, pendingUploads, activeUploads } = useUploadStore();

  const handleAddVideo = (video: any) => {
    const srcVideo = video.metadata?.uploadedUrl || video.url;

    dispatch(ADD_VIDEO, {
      payload: {
        id: generateId(),
        details: {
          src: srcVideo
        },
        metadata: {
          previewUrl: ""
        }
      },
      options: {
        targetTrackId: "video",
        scaleMode: "fit"
      }
    });
  };

  // Filter local uploads for video
  const videos = uploads.filter(
    (upload) => upload.type?.startsWith("video/") || upload.type === "video"
  );
  
  // Apply local search filter
  const displayVideos = videos.filter((video) => {
    if (!searchQuery.trim()) return true;
    const name = (video.file?.name || video.fileName || video.url || "").toLowerCase();
    return name.includes(searchQuery.toLowerCase());
  });

  const UploadPrompt = () => (
    <div className="flex items-center justify-center px-4 pt-4 pb-2">
      <Button
        className="w-full cursor-pointer"
        onClick={() => setShowUploadModal(true)}
        variant={"outline"}
      >
        <UploadIcon className="w-4 h-4" />
        <span className="ml-2">Upload Video</span>
      </Button>
    </div>
  );

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <ModalUpload type="video" />
      <UploadPrompt />

      <div className="flex items-center gap-2 p-4 pt-2">
        <div className="relative flex-1">
          <Button
            size="sm"
            variant="ghost"
            className="absolute left-1 top-1/2 h-6 w-6 -translate-y-1/2 p-0"
          >
            <Search className="h-3 w-3" />
          </Button>
          <Input
            placeholder="Search uploaded videos..."
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

      <div className="flex-1 min-h-0 overflow-y-auto px-4">
          {displayVideos.length === 0 && !searchQuery ? (
             <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
              <VideoIcon size={32} className="opacity-50" />
              <span className="text-sm">No videos uploaded yet</span>
            </div>
          ) : displayVideos.length === 0 && searchQuery ? (
             <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
              <Search size={32} className="opacity-50" />
              <span className="text-sm">No matches found</span>
             </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2 pb-4">
              {displayVideos.map((video, index) => {
                // Ensure preview exists, fallback to url or generic icon later
                const previewSrc = video.metadata?.uploadedUrl || video.url;
                
                return (
                  <VideoItem
                    key={video.id || index}
                    video={video}
                    shouldDisplayPreview={!isDraggingOverTimeline}
                    handleAddVideo={handleAddVideo}
                    previewSrc={previewSrc}
                  />
                );
              })}
            </div>
          )}
      </div>
    </div>
  );
};

const VideoItem = ({
  handleAddVideo,
  video,
  previewSrc,
  shouldDisplayPreview
}: {
  handleAddVideo: (video: any) => void;
  video: any;
  previewSrc: string;
  shouldDisplayPreview: boolean;
}) => {
  const style = React.useMemo(
    () => ({
      backgroundImage: `url(${previewSrc})`,
      backgroundSize: "cover",
      width: "80px",
      height: "80px"
    }),
    [previewSrc]
  );

  return (
    <Draggable
      data={{
        ...video,
        metadata: {
          previewUrl: previewSrc
        }
      }}
      renderCustomPreview={<div style={style} className="draggable" />}
      shouldDisplayPreview={shouldDisplayPreview}
    >
      <div
        onClick={() => handleAddVideo(video)}
        className="relative aspect-square flex w-full items-center justify-center overflow-hidden bg-background pb-2 group cursor-pointer border rounded-md"
      >
        {/* We use a video element to generate a preview since we don't have thumbnails for local uploads unless generated */}
        <video
          draggable={false}
          src={previewSrc}
          className="h-full w-full object-cover"
          preload="metadata"
          muted
        />
        <div className="absolute inset-0 flex flex-col justify-end p-2 bg-gradient-to-t from-black/60 to-transparent">
             <div className="text-[10px] text-white truncate max-w-full">
                {video.file?.name || video.fileName || "Video"}
             </div>
        </div>
        {/* Play button overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity rounded-md">
          <div className="rounded-full p-1 bg-black/50 text-white">
            <PlusIcon className="h-6 w-6" />
          </div>
        </div>
      </div>
    </Draggable>
  );
};
