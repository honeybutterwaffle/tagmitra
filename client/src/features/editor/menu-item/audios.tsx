import Draggable from "@/components/shared/draggable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { dispatch } from "@designcombo/events";
import { ADD_AUDIO } from "@designcombo/state";
import { IAudio } from "@designcombo/types";
import { Loader2, Music, Music2, Search, UploadIcon } from "lucide-react";
import React, { useState } from "react";
import { generateId } from "@designcombo/timeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AudioItem } from "./audio-item";
import useUploadStore from "../store/use-upload-store";
import ModalUpload from "@/components/modal-upload";

export const Audios = () => {
  const [searchQuery, setSearchQuery] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const { setShowUploadModal, uploads } = useUploadStore();

  const handleAddAudio = (audio: any) => {
    const srcAudio = audio.metadata?.uploadedUrl || audio.url;
    dispatch(ADD_AUDIO, {
      payload: {
        id: generateId(),
        type: "audio",
        details: {
          src: srcAudio
        },
        metadata: {}
      },
      options: {}
    });
  };

  // Filter local uploads for audio
  const audios = uploads.filter(
    (upload) => upload.type?.startsWith("audio/") || upload.type === "audio"
  );
  
  // Apply local search filter
  const displayAudios = audios.filter((audio) => {
    if (!searchQuery.trim()) return true;
    const name = (audio.file?.name || audio.fileName || audio.url || "").toLowerCase();
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
        <span className="ml-2">Upload Audio</span>
      </Button>
    </div>
  );

  return (
    <div className="flex flex-1 flex-col max-w-full h-full">
      <ModalUpload type="audio" />
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
            placeholder="Search uploaded audios..."
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

      <ScrollArea className="flex-1 max-w-full px-4">
        {displayAudios.length === 0 && !searchQuery ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
            <Music2 size={32} className="opacity-50" />
            <span className="text-sm">No audio uploaded yet</span>
          </div>
        ) : displayAudios.length === 0 && searchQuery ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
             <Search size={32} className="opacity-50" />
             <span className="text-sm">No matches found</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2 pb-4">
            {displayAudios.map((audio, index) => {
              // Map local upload schema to what AudioItem expects
              const mappedAudio = {
                id: audio.id || String(index),
                name: audio.file?.name || audio.fileName || "Audio",
                details: {
                  src: audio.metadata?.uploadedUrl || audio.url
                }
              };

              return (
                <AudioItem
                  onAdd={(item) => handleAddAudio(audio)}
                  item={mappedAudio}
                  key={mappedAudio.id}
                  playingId={playingId}
                  setPlayingId={setPlayingId}
                />
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
};
