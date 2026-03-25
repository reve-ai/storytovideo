import { create } from "zustand";

export type ViewName = "queue" | "graph" | "story";

interface UIState {
  currentView: ViewName;
  detailPanelOpen: boolean;
  detailItemId: string | null;
  hideSuperseded: boolean;
}

interface UIActions {
  setView: (view: ViewName) => void;
  openDetail: (itemId: string) => void;
  closeDetail: () => void;
  setHideSuperseded: (hide: boolean) => void;
}

export type UIStore = UIState & UIActions;

export const useUIStore = create<UIStore>((set) => ({
  currentView: "queue",
  detailPanelOpen: false,
  detailItemId: null,
  hideSuperseded: false,

  setView: (view: ViewName) => {
    set({ currentView: view });
  },

  openDetail: (itemId: string) => {
    set({ detailPanelOpen: true, detailItemId: itemId });
  },

  closeDetail: () => {
    set({ detailPanelOpen: false, detailItemId: null });
  },

  setHideSuperseded: (hide: boolean) => {
    set({ hideSuperseded: hide });
  },
}));

