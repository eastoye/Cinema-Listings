import { useEffect, useMemo, useState } from "react";
import { fetchAllUpcomingScreenings } from "./screeningsApi.js";
import { SUPABASE_CONFIGURED } from "./supabaseClient.js";
import { londonDateKey } from "./time.js";
import { DayGroup } from "./ScreeningRow.jsx";

export default function App() {
  const [screenings, setScreenings] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | error | ready
  const [errorMsg, setErrorMsg] = useState("");
  const [search, setSearch] = useState("");
  const [cinema, setCinema] = useState("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchAllUpcomingScreenings();
        if (cancelled) return;
        setScreenings(rows);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const cinemas = useMemo(() => {
    const set = new Set();
    for (const s of screenings) set.add(s.cinema_name);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [screenings]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return screenings.filter((s) => {
      if (cinema !== "all" && s.cinema_name !== cinema) return false;
      if (q && !s.movie_title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [screenings, search, cinema]);

  // Group by London calendar date, preserving start_time ascending order.
  const groups = useMemo(() => {
    const map = new Map();
    for (const s of filtered) {
      const key = londonDateKey(s.start_time);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(s);
    }
    return Array.from(map.entries());
  }, [filtered]);

  return (
    <div className="app">
      <header className="site-header">
        <h1 className="site-title">Cinema Listings</h1>
        <p className="site-subtitle">
          Upcoming screenings in London, updated from each cinema's programme.
        </p>
      </header>

      <div className="controls">
        <label className="search">
          <span className="search-icon" aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <input
            type="search"
            placeholder="Search movie title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search movie title"
          />
        </label>
        <select
          className="cinema-filter"
          value={cinema}
          onChange={(e) => setCinema(e.target.value)}
          aria-label="Filter by cinema"
        >
          <option value="all">All cinemas</option>
          {cinemas.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {!SUPABASE_CONFIGURED && (
        <div className="status error">
          Supabase is not configured. Set <code>VITE_SUPABASE_URL</code> and{" "}
          <code>VITE_SUPABASE_ANON_KEY</code> in the environment.
        </div>
      )}

      {SUPABASE_CONFIGURED && status === "loading" && (
        <div className="status">
          <div className="spinner" />
          Loading upcoming screenings…
        </div>
      )}

      {SUPABASE_CONFIGURED && status === "error" && (
        <div className="status error">
          Couldn't load screenings right now. {errorMsg}
        </div>
      )}

      {SUPABASE_CONFIGURED && status === "ready" && groups.length === 0 && (
        <div className="status">No upcoming screenings found.</div>
      )}

      {SUPABASE_CONFIGURED && status === "ready" && groups.length > 0 && (
        <main>
          {groups.map(([key, rows]) => (
            <DayGroup key={key} dateKey={key} screenings={rows} />
          ))}
        </main>
      )}

      <footer className="footer">
        {screenings.length > 0 && status === "ready" && (
          <span>
            {filtered.length} upcoming screening
            {filtered.length === 1 ? "" : "s"}
            {cinema !== "all" ? ` at ${cinema}` : ""}.
          </span>
        )}
      </footer>
    </div>
  );
}
