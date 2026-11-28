import { useEffect, useState } from "react";
import { getCurrentUser } from "./api.js";
import AlertsPage from "./pages/AlertsPage.jsx";
import FloorPage from "./pages/FloorPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import InventoryPage from "./pages/InventoryPage.jsx";
import RulesPage from "./pages/RulesPage.jsx";
import StockPage from "./pages/StockPage.jsx";
import { Loading } from "./ui.jsx";
import { useApi } from "./useApi.js";

const ROLE_LABELS = {
  manager: "Manager",
  kitchen_staff: "Kitchen staff",
  purchasing_staff: "Purchasing staff",
};

const TABS = [
  { id: "stock", label: "Current stock", Page: StockPage },
  { id: "inventory", label: "Inventory", Page: InventoryPage },
  { id: "floor", label: "Floor plan", Page: FloorPage },
  { id: "history", label: "Stock history", Page: HistoryPage },
  { id: "alerts", label: "Alerts", Page: AlertsPage },
  { id: "rules", label: "Alert rules", Page: RulesPage },
];

// The open tab lives in the URL hash, so refresh and back/forward work.
// It can carry parameters, e.g. #/stock?product=3&item=16 to point at an item.
function routeFromHash() {
  const [path, query = ""] = window.location.hash.replace(/^#\/?/, "").split("?");
  return {
    tab: TABS.find((t) => t.id === path) ?? TABS[0],
    params: Object.fromEntries(new URLSearchParams(query)),
  };
}

function useHashRoute() {
  const [route, setRoute] = useState(routeFromHash);
  useEffect(() => {
    const onChange = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export default function App() {
  const { data: user, error } = useApi(getCurrentUser);
  const { tab, params } = useHashRoute();
  const { Page } = tab;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path
                  d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14Zm0 0 7-7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            Smart Inventory Fridge
          </span>
          <span className="topbar-actions">
            <a className="topbar-link" href="/simulator.html" target="_blank" rel="noreferrer">
              Fridge simulator ↗
            </a>
            {user && (
              <span className="user">
                <span className="avatar" aria-hidden="true">
                  {user.name
                    .split(" ")
                    .map((part) => part[0])
                    .join("")
                    .slice(0, 2)}
                </span>
                <span>
                  <span className="user-name">{user.name}</span>
                  <span className="user-role">{ROLE_LABELS[user.role] ?? user.role}</span>
                </span>
              </span>
            )}
          </span>
        </div>
        {user?.role === "manager" && (
          <nav className="tabs" aria-label="Manager dashboard">
            {TABS.map((t) => (
              <a
                key={t.id}
                href={`#/${t.id}`}
                className="tab"
                aria-current={t.id === tab.id ? "page" : undefined}
              >
                {t.label}
              </a>
            ))}
          </nav>
        )}
      </header>
      <main>
        {!user ? (
          <Loading error={error} />
        ) : user.role === "manager" ? (
          <Page key={tab.id} params={params} />
        ) : (
          <p className="muted">The dashboard is for managers.</p>
        )}
      </main>
    </>
  );
}
