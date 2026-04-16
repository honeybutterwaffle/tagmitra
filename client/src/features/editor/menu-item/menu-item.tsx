import useLayoutStore from "../store/use-layout-store";
import { Transitions } from "./transitions";
import { Texts } from "./texts";
import {
  BackgroundMusicMenu,
  OverlayMenu,
  PackageMenu
} from "./promo-media";
import { AssetsMenu } from "./assets-menu";

const ActiveMenuItem = () => {
  const { activeMenuItem } = useLayoutStore();

  switch (activeMenuItem) {
    case "package":
      return <PackageMenu />;
    case "backgroundMusic":
      return <BackgroundMusicMenu />;
    case "assets":
      return <AssetsMenu />;
    case "overlay":
      return <OverlayMenu />;
    case "texts":
      return <Texts />;
    case "transitions":
      return <Transitions />;
    default:
      return null;
  }
};

export const MenuItem = () => {
  return (
    <div className="w-full h-full flex flex-col overflow-hidden">
      <ActiveMenuItem />
    </div>
  );
};
