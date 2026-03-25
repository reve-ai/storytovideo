import { useState } from "react";
import { Outlet } from "react-router";
import TopBar from "./TopBar";
import CreateRunDialog from "./CreateRunDialog";
import DetailPanel from "./DetailPanel";
import Toast from "./Toast";

export default function AppLayout() {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="app-layout">
      <TopBar onNewRun={() => setDialogOpen(true)} />
      <main className="view-content">
        <Outlet />
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

