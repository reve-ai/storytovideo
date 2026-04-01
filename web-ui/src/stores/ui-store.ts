import { create } from "zustand";
import { getUrlState, setUrlState } from "./run-store";

export type ViewName = "queue" | "graph" | "script" | "story" | "video" | "timeline" | "analyze" | "assets";
export type ToastType = "info" | "warning" | "error";

export interface ToastMessage {
  id: number;
  message: string;
  type: ToastType;
}

interface UIState {
  currentView: ViewName;
  detailPanelOpen: boolean;
  detailItemId: string | null;
  hideSuperseded: boolean;
  toasts: ToastMessage[];
}

interface UIActions {
  setView: (view: ViewName) => void;
  openDetail: (itemId: string) => void;
  closeDetail: () => void;
  setHideSuperseded: (hide: boolean) => void;
  showToast: (message: string, type?: ToastType) => void;
  dismissToast: (id: number) => void;
}

export type UIStore = UIState & UIActions;

let toastCounter = 0;

export const useUIStore = create<UIStore>((set, get) => ({
  currentView: "queue",
  detailPanelOpen: false,
  detailItemId: null,
  hideSuperseded: false,
  toasts: [],

  setView: (view: ViewName) => {
    set({ currentView: view });
    const currentHash = getUrlState();
    setUrlState(currentHash.runId, view);
  },

  openDetail: (itemId: string) => {
    const { detailPanelOpen, detailItemId } = get();
    if (detailPanelOpen && detailItemId === itemId) {
      set({ detailPanelOpen: false, detailItemId: null });
    } else {
      set({ detailPanelOpen: true, detailItemId: itemId });
    }
  },

  closeDetail: () => {
    set({ detailPanelOpen: false, detailItemId: null });
  },

  setHideSuperseded: (hide: boolean) => {
    set({ hideSuperseded: hide });
  },

  showToast: (message: string, type: ToastType = "info") => {
    const id = ++toastCounter;
    set({ toasts: [...get().toasts, { id, message, type }] });
    setTimeout(() => {
      get().dismissToast(id);
    }, 5000);
  },

  dismissToast: (id: number) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

