import useLayoutStore from "../store/use-layout-store";
import { Transitions } from "./transitions";
import { Texts } from "./texts";
import { Elements } from "./elements";
import { Images } from "./images";
import { Videos } from "./videos";
import { Audios } from "./audios";
import { VoiceOver } from "./voice-over";
import { useIsLargeScreen } from "@/hooks/use-media-query";

const ActiveMenuItem = () => {
  const { activeMenuItem } = useLayoutStore();

  if (activeMenuItem === "transitions") {
    return <Transitions />;
  }
  if (activeMenuItem === "texts") {
    return <Texts />;
  }
  if (activeMenuItem === "shapes") {
    return <Elements />;
  }
  if (activeMenuItem === "videos") {
    return <Videos />;
  }
  if (activeMenuItem === "audios") {
    return <Audios />;
  }
  if (activeMenuItem === "images") {
    return <Images />;
  }
  if (activeMenuItem === "voiceOver") {
    return <VoiceOver />;
  }
  if (activeMenuItem === "elements") {
    return <Elements />;
  }

  return null;
};

export const MenuItem = () => {
  return (
    <div className={`w-full flex-1 flex h-[calc(100%-50px)]`}>
      <ActiveMenuItem />
    </div>
  );
};
