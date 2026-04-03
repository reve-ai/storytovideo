import { useState } from "react";
import { Outlet } from "react-router";
import TopBar from "./TopBar";
import CreateRunDialog from "./CreateRunDialog";
import DetailPanel from "./DetailPanel";
import Toast from "./Toast";
import HomeView from "../views/HomeView";
import { useRunStore } from "../stores/run-store";

export default function AppLayout() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const activeRunId = useRunStore((s) => s.activeRunId);

  return (
    <div className="app-layout">
      <TopBar onNewRun={() => setDialogOpen(true)} />
      <main className="view-content">
        {activeRunId ? <Outlet /> : <HomeView onNewRun={() => setDialogOpen(true)} />}
      </main>
      <CreateRunDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
      <DetailPanel />
      <Toast />
    </div>
  );
}

