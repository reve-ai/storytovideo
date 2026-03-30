import { Routes, Route } from "react-router";
import AppLayout from "./components/AppLayout";
import GraphView from "./views/GraphView";
import QueueView from "./views/QueueView";
import StoryView from "./views/StoryView";
import VideoView from "./views/VideoView";
import AnalyzeView from "./views/AnalyzeView";
import AssetsView from "./views/AssetsView";

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<QueueView />} />
        <Route path="/graph" element={<GraphView />} />
        <Route path="/story" element={<StoryView />} />
        <Route path="/video" element={<VideoView />} />
        <Route path="/analyze" element={<AnalyzeView />} />
        <Route path="/assets" element={<AssetsView />} />
      </Route>
    </Routes>
  );
}

