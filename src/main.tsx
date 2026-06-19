import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Catch unhandled promise rejections globally so they surface in the console
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Global] Unhandled promise rejection:', event.reason);
});

createRoot(document.getElementById("root")!).render(<App />);
