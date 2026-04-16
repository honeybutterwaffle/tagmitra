import type StateManager from "@designcombo/state";

let editorStateManager: StateManager | null = null;

/** Set once from editor so promo/upload code can read canonical timeline state. */
export function setEditorStateManager(sm: StateManager | null): void {
  editorStateManager = sm;
}

export function getEditorStateManager(): StateManager | null {
  return editorStateManager;
}
