import { Routes, Route } from "react-router";
import AppLayout from "./components/AppLayout";
import GraphView from "./views/GraphView";
import QueueView from "./views/QueueView";
import StoryView from "./views/StoryView";

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<QueueView />} />
        <Route path="/graph" element={<GraphView />} />
        <Route path="/story" element={<StoryView />} />
      </Route>
    </Routes>
  );
}

