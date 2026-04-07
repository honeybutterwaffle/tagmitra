"""
Pydantic models matching the frontend IDesign data structure.
"""
from __future__ import annotations
from typing import Any, Optional
from pydantic import BaseModel, Field


class BoxShadow(BaseModel):
    color: str = "#000000"
    x: float = 0
    y: float = 0
    blur: float = 0


class CaptionWord(BaseModel):
    word: str
    start: float  # ms
    end: float    # ms
    confidence: float = 0
    is_keyword: bool = False


class TrackItemDetails(BaseModel):
    """Union of all possible detail fields across item types."""
    # Common visual
    width: Optional[Any] = None
    height: Optional[Any] = None
    opacity: Optional[float] = 100
    top: Optional[str] = "0px"
    left: Optional[str] = "0px"
    transform: Optional[str] = "none"
    transformOrigin: Optional[str] = "center center"
    rotate: Optional[str] = "0deg"
    borderRadius: Optional[float] = 0
    borderWidth: Optional[float] = 0
    borderColor: Optional[str] = "#000000"
    boxShadow: Optional[BoxShadow] = None
    blur: Optional[float] = 0
    brightness: Optional[float] = 100
    flipX: Optional[bool] = False
    flipY: Optional[bool] = False
    visibility: Optional[str] = "visible"

    # Media
    src: Optional[str] = None
    volume: Optional[float] = 100

    # Crop
    crop: Optional[dict] = None

    # Text / Caption
    text: Optional[str] = None
    fontSize: Optional[Any] = 16
    fontFamily: Optional[str] = "Arial"
    fontUrl: Optional[str] = None
    fontWeight: Optional[str] = "normal"
    fontStyle: Optional[str] = "normal"
    color: Optional[str] = "#000000"
    backgroundColor: Optional[str] = "transparent"
    textAlign: Optional[str] = "left"
    textDecoration: Optional[str] = "none"
    textTransform: Optional[str] = "none"
    lineHeight: Optional[str] = "normal"
    letterSpacing: Optional[str] = "normal"
    wordSpacing: Optional[str] = "normal"
    wordWrap: Optional[str] = "normal"
    wordBreak: Optional[str] = "normal"

    # Text stroke
    WebkitTextStrokeColor: Optional[str] = None
    WebkitTextStrokeWidth: Optional[str] = None

    # Caption-specific
    words: Optional[list[CaptionWord]] = None
    activeColor: Optional[str] = None
    activeFillColor: Optional[str] = None
    appearedColor: Optional[str] = None
    linesPerCaption: Optional[int] = 1
    animation: Optional[str] = None
    isKeywordColor: Optional[str] = "transparent"
    preservedColorKeyWord: Optional[bool] = False
    showObject: Optional[str] = None
    wordsPerLine: Optional[str] = None

    # Shape
    svgString: Optional[str] = None

    # Progress
    backgroundColors: Optional[list[str]] = None
    inverted: Optional[bool] = False

    # Background
    background: Optional[Any] = None

    class Config:
        extra = "allow"


class DisplayRange(BaseModel):
    from_: float = Field(alias="from", default=0)
    to: float = 0

    class Config:
        populate_by_name = True


class TrimRange(BaseModel):
    from_: float = Field(alias="from", default=0)
    to: float = 0

    class Config:
        populate_by_name = True


class TrackItem(BaseModel):
    id: str
    name: Optional[str] = None
    type: str  # video, audio, image, text, caption, shape, etc.
    display: DisplayRange
    trim: Optional[TrimRange] = None
    details: TrackItemDetails
    metadata: Optional[dict] = None
    playbackRate: Optional[float] = 1
    duration: Optional[float] = None
    isMain: Optional[bool] = False
    animations: Optional[dict] = None

    class Config:
        extra = "allow"


class Transition(BaseModel):
    id: str
    fromId: str
    toId: str
    kind: str  # fade, slide, wipe, flip, clockWipe, star, circle, rectangle, none
    duration: float  # ms
    direction: Optional[str] = None  # from-top, from-bottom, from-left, from-right
    type: Optional[str] = "transition"

    class Config:
        extra = "allow"


class Track(BaseModel):
    id: str
    items: list[str] = []
    type: Optional[str] = None
    name: Optional[str] = None
    accepts: Optional[list[str]] = None
    magnetic: Optional[bool] = False
    static: Optional[bool] = False


class CanvasSize(BaseModel):
    width: int = 1080
    height: int = 1920


class Design(BaseModel):
    id: str
    fps: int = 30
    tracks: list[Track] = []
    size: CanvasSize = CanvasSize()
    trackItemIds: list[str] = []
    transitionsMap: dict[str, Transition] = {}
    trackItemsMap: dict[str, TrackItem] = {}
    transitionIds: Optional[list[str]] = None
    duration: Optional[float] = None

    class Config:
        extra = "allow"


class RenderOptions(BaseModel):
    fps: int = 30
    size: Optional[CanvasSize] = None
    format: str = "mp4"


class RenderRequest(BaseModel):
    design: Design
    options: RenderOptions
