import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Catch unhandled promise rejections globally so they surface in the console
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Global] Unhandled promise rejection:', event.reason);
});

// A tab opened before a deploy lazy-loads route chunks by hashes that no
// longer exist. Vite raises vite:preloadError for that; reload once so the
// fresh index.html and its chunks take over. The guard stops a reload loop.
window.addEventListener('vite:preloadError', (event) => {
  const key = 'ecg:chunk-reload';
  try {
    if (sessionStorage.getItem(key) === location.href) return;
    sessionStorage.setItem(key, location.href);
  } catch { /* storage blocked: still reload once */ }
  event.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(<App />);
