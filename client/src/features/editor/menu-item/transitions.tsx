import React from "react";
import Draggable from "@/components/shared/draggable";
import { TRANSITIONS } from "../data/transitions";
import { useIsDraggingOverTimeline } from "../hooks/is-dragging-over-timeline";

export const Transitions = () => {
  const isDraggingOverTimeline = useIsDraggingOverTimeline();

  return (
    <div className="flex flex-1 flex-col py-4 min-h-0 overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto px-4">
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(80px,1fr))]">
          {TRANSITIONS.map((transition, index) => (
            <TransitionsMenuItem
              key={index}
              transition={transition}
              shouldDisplayPreview={!isDraggingOverTimeline}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

const TransitionsMenuItem = ({
  transition,
  shouldDisplayPreview
}: {
  transition: Partial<any>;
  shouldDisplayPreview: boolean;
}) => {
  const isDisabled = transition.disabled === true;
  const style = React.useMemo(
    () => ({
      backgroundImage: `url(${transition.preview})`,
      backgroundSize: "cover",
      width: "70px",
      height: "70px"
    }),
    [transition.preview]
  );

  const content = (
    <div className="w-full" title={isDisabled ? "Not supported in export" : undefined}>
      <div className="w-full flex items-center justify-center">
        <div
          style={{
            ...style,
            ...(isDisabled ? { filter: "grayscale(100%)", opacity: 0.4 } : {})
          }}
          draggable={false}
        />
      </div>
      <div className="flex w-full h-6 items-center justify-center text-center overflow-hidden text-ellipsis whitespace-nowrap text-[12px] capitalize text-muted-foreground">
        {transition.name || transition.type}
        {isDisabled && " ⛔"}
      </div>
    </div>
  );

  if (isDisabled) {
    return (
      <div className="cursor-not-allowed">
        {content}
      </div>
    );
  }

  return (
    <Draggable
      data={transition}
      renderCustomPreview={<div style={style} />}
      shouldDisplayPreview={shouldDisplayPreview}
    >
      {content}
    </Draggable>
  );
};

export default TransitionsMenuItem;
