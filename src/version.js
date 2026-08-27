// One string, changed by hand whenever the interface gains or loses a feature.
//
// It exists because of a concrete incident: a research run was carried out on
// a browser tab that had been open since before the selection feature was
// deployed. The page looked current, GitHub Pages *was* current, and the
// feature was simply not in the JavaScript the tab was running. Nothing on
// screen could have told anyone that.
//
// Now it can. The footer shows this string and the console logs it, so
// "which version am I looking at?" is a question with an answer instead of an
// inference from deploy timestamps.
export const UI_VERSION = "2026-08-28 · Phase 7 (Auswahl und Kopieren)";
