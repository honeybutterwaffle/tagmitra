import { ScrollArea } from "@/components/ui/scroll-area";
import { dispatch } from "@designcombo/events";
import { generateId } from "@designcombo/timeline";
import Draggable from "@/components/shared/draggable";
import { IImage } from "@designcombo/types";
import React, { useState } from "react";
import { useIsDraggingOverTimeline } from "../hooks/is-dragging-over-timeline";
import { ADD_IMAGE } from "@designcombo/state";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Image as ImageIcon, UploadIcon } from "lucide-react";
import useUploadStore from "../store/use-upload-store";
import ModalUpload from "@/components/modal-upload";

export const Images = () => {
  const isDraggingOverTimeline = useIsDraggingOverTimeline();
  const [searchQuery, setSearchQuery] = useState("");
  const { setShowUploadModal, uploads } = useUploadStore();

  const handleAddImage = (image: any) => {
    const srcImage = image.metadata?.uploadedUrl || image.url;

    dispatch(ADD_IMAGE, {
      payload: {
        id: generateId(),
        type: "image",
        display: {
          from: 0,
          to: 5000
        },
        details: {
          src: srcImage
        },
        metadata: {}
      },
      options: {}
    });
  };

  // Filter local uploads for image
  const images = uploads.filter(
    (upload) => upload.type?.startsWith("image/") || upload.type === "image"
  );
  
  // Apply local search filter
  const displayImages = images.filter((image) => {
    if (!searchQuery.trim()) return true;
    const name = (image.file?.name || image.fileName || image.url || "").toLowerCase();
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
        <span className="ml-2">Upload Image</span>
      </Button>
    </div>
  );

  return (
    <div className="flex flex-1 flex-col">
      <ModalUpload type="image" />
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
            placeholder="Search uploaded images..."
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

      <ScrollArea className="flex-1 px-4 max-h-full">
        <div className="max-h-full">
          {displayImages.length === 0 && !searchQuery ? (
             <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
              <ImageIcon size={32} className="opacity-50" />
              <span className="text-sm">No images uploaded yet</span>
            </div>
          ) : displayImages.length === 0 && searchQuery ? (
             <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
              <Search size={32} className="opacity-50" />
              <span className="text-sm">No matches found</span>
             </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2 pb-4">
              {displayImages.map((image, index) => {
                const previewSrc = image.metadata?.uploadedUrl || image.url;
                return (
                  <ImageItem
                    key={image.id || index}
                    image={image}
                    shouldDisplayPreview={!isDraggingOverTimeline}
                    handleAddImage={handleAddImage}
                    previewSrc={previewSrc}
                  />
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

const ImageItem = ({
  handleAddImage,
  image,
  previewSrc,
  shouldDisplayPreview
}: {
  handleAddImage: (image: any) => void;
  image: any;
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
        ...image,
        metadata: {
          previewUrl: previewSrc
        }
      }}
      renderCustomPreview={<div style={style} />}
      shouldDisplayPreview={shouldDisplayPreview}
    >
      <div
        onClick={() => handleAddImage(image)}
        className="flex aspect-square w-full items-center justify-center overflow-hidden bg-background border rounded-md cursor-pointer relative group"
      >
        <img
          draggable={false}
          src={previewSrc}
          className="h-full w-full object-cover"
          alt="Visual content"
        />
        <div className="absolute inset-0 flex flex-col justify-end p-2 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="text-[10px] text-white truncate max-w-full">
               {image.file?.name || image.fileName || "Image"}
            </div>
        </div>
      </div>
    </Draggable>
  );
};
