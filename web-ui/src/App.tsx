import { Routes, Route, NavLink } from "react-router";

function Queue() {
  return <div className="p-4 text-[--muted]">Queue view</div>;
}

function Graph() {
  return <div className="p-4 text-[--muted]">Graph view</div>;
}

function Story() {
  return <div className="p-4 text-[--muted]">Story view</div>;
}

export default function App() {
  return (
    <div className="min-h-screen bg-[--bg] text-[--text]">
      <nav className="flex items-center gap-1 border-b border-[--border] bg-[--surface] px-4 py-2">
        <span className="mr-4 text-sm font-semibold">StoryToVideo</span>
        {[
          { to: "/", label: "Queue" },
          { to: "/graph", label: "Graph" },
          { to: "/story", label: "Story" },
        ].map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `rounded px-3 py-1 text-sm transition-colors ${
                isActive
                  ? "bg-[--accent] text-white"
                  : "text-[--muted] hover:text-[--text]"
              }`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Queue />} />
          <Route path="/graph" element={<Graph />} />
          <Route path="/story" element={<Story />} />
        </Routes>
      </main>
    </div>
  );
}

