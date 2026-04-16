import { Routes, Route } from "react-router";
import AppLayout from "./components/AppLayout";
import GraphView from "./views/GraphView";
import QueueView from "./views/QueueView";
import ScriptView from "./views/ScriptView";
import StoryView from "./views/StoryView";
import StoryEditorView from "./views/StoryEditorView";
import VideoView from "./views/VideoView";
import AnalyzeView from "./views/AnalyzeView";
import AssetsView from "./views/AssetsView";
import TimelineView from "./views/TimelineView";

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<QueueView />} />
        <Route path="/script" element={<ScriptView />} />
        <Route path="/graph" element={<GraphView />} />
        <Route path="/story-grid" element={<StoryView />} />
        <Route path="/story" element={<StoryEditorView />} />
        <Route path="/video" element={<VideoView />} />
        <Route path="/timeline" element={<TimelineView />} />
        <Route path="/analyze" element={<AnalyzeView />} />
        <Route path="/assets" element={<AssetsView />} />
      </Route>
    </Routes>
  );
}

