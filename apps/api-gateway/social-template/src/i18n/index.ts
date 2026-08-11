import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import zhCN from "./zh-CN.json";
import zhTW from "./zh-TW.json";

// i18next-browser-languagedetector isn't in preview-service's pre-baked
// package set (that shared image is what every preview actually runs
// against) -- it was a hard top-level import, so its absence broke i18n
// initialization app-wide, not just the language-detection feature.
// Read/write localStorage directly instead; the language switcher (Navbar)
// still works via i18n.changeLanguage, it just doesn't guess the browser's
// language on first load anymore.
const STORAGE_KEY = "i18nextLng";
const storedLng = (() => {
  try { return localStorage.getItem(STORAGE_KEY) ?? undefined; } catch { return undefined; }
})();

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      "zh-CN": { translation: zhCN },
      "zh-TW": { translation: zhTW },
    },
    lng: storedLng,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });

i18n.on("languageChanged", (lng) => {
  try { localStorage.setItem(STORAGE_KEY, lng); } catch { /* storage unavailable */ }
});

export default i18n;
