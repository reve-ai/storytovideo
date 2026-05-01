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
  useChatDetailPanel: boolean;
  locationChatName: string | null;
  objectChatName: string | null;
  toasts: ToastMessage[];
}

interface UIActions {
  setView: (view: ViewName) => void;
  openDetail: (itemId: string) => void;
  closeDetail: () => void;
  setHideSuperseded: (hide: boolean) => void;
  setUseChatDetailPanel: (enabled: boolean) => void;
  openLocationChat: (name: string) => void;
  closeLocationChat: () => void;
  openObjectChat: (name: string) => void;
  closeObjectChat: () => void;
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
  useChatDetailPanel: true,
  locationChatName: null,
  objectChatName: null,
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

  setUseChatDetailPanel: (enabled: boolean) => {
    set({ useChatDetailPanel: enabled });
  },

  openLocationChat: (name: string) => {
    set({ locationChatName: name });
  },

  closeLocationChat: () => {
    set({ locationChatName: null });
  },

  openObjectChat: (name: string) => {
    set({ objectChatName: name });
  },

  closeObjectChat: () => {
    set({ objectChatName: null });
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

