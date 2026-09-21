/**
 * LINKWATCH's small, coherent icon set.
 *
 * The product is served as a static vanilla app, so a focused inline set keeps
 * icons predictable without adding a runtime dependency or loading a second
 * visual language. Paths follow the familiar 24px outline icon convention.
 */
const PATHS = Object.freeze({
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  alert: '<path d="M12 3.5 21 19.2H3Z"/><path d="M12 8.3v5.1" stroke-width="2.25"/><rect x="10.7" y="15.7" width="2.6" height="2.6" rx="1.1" fill="currentColor" stroke="none"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  barChart: '<rect x="4.2" y="3.8" width="15.6" height="16.4" rx="2.6"/><rect x="7.2" y="13.4" width="2.5" height="3.8" rx="1.1" fill="currentColor" stroke="none"/><rect x="10.8" y="10.3" width="2.5" height="6.9" rx="1.1" fill="currentColor" stroke="none"/><rect x="14.4" y="7.2" width="2.5" height="10" rx="1.1" fill="currentColor" stroke="none"/>',
  bell: '<path d="M6.2 10.4a5.8 5.8 0 0 1 11.6 0v2.5c0 1.7.8 2.8 1.8 3.8H4.4c1-1 1.8-2.1 1.8-3.8Z" fill="currentColor" fill-opacity=".16"/><path d="M6.2 10.4a5.8 5.8 0 0 1 11.6 0v2.5c0 1.7.8 2.8 1.8 3.8H4.4c1-1 1.8-2.1 1.8-3.8Z"/><path d="M9.4 19.2h5.2" stroke-width="2.15"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  case: '<rect x="3.5" y="6.2" width="17" height="12.1" rx="2.5"/><path d="m5.1 8 6.9 5.1L18.9 8"/><rect x="16.8" y="3.7" width="4.1" height="4.1" rx="1.5" fill="currentColor" stroke="none"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 9h6M9 13h6M9 17h3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  external: '<path d="M14 3h7v7M10 14 21 3M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/>',
  filter: '<path d="M4 5h16M7 12h10M10 19h4"/>',
  history: '<path d="M12 4.1a7.9 7.9 0 1 1-5.6 2.3"/><path d="M4 4.4v4.8h4.8"/><path d="M12 8v4.5l3.2 1.8" stroke-width="2.1"/><circle cx="12" cy="12.5" r="1.55" fill="currentColor" stroke="none"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M9 21v-7h6v7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  logout: '<path d="M10 17l5-5-5-5M15 12H3M21 19V5a2 2 0 0 0-2-2h-5"/>',
  map: '<path d="M4.2 6.7 9.1 4.2l5.8 2.5 4.9-2.5v13.2l-4.9 2.4-5.8-2.4-4.9 2.4Z"/><path d="M9.1 4.2v13.2M14.9 6.7v13.1"/><circle cx="14.9" cy="11.2" r="2.15" fill="currentColor" stroke="none"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  minus: '<path d="M5 12h14"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 8.5 8.5 0 1 0 20.5 14.5Z"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  paperclip: '<path d="m21.4 11.6-8.8 8.8a6 6 0 0 1-8.5-8.5l8.8-8.8a4 4 0 0 1 5.7 5.7l-8.8 8.8a2 2 0 0 1-2.8-2.8l8.1-8.1"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.8-3L3 11M4 5v6h6M4 13a8 8 0 0 0 14.8 3L21 13M20 19v-6h-6"/>',
  router: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11h.01M11 11h.01M15 11h.01M8 17v3M16 17v3M6 20h12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 7h.01M7 18h.01"/>',
  settings: '<path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="2.45" fill="currentColor" stroke="none"/><circle cx="15.5" cy="12" r="2.45" fill="currentColor" stroke="none"/><circle cx="11.5" cy="18" r="2.45" fill="currentColor" stroke="none"/>',
  school: '<path d="m3.5 9 8.5-5 8.5 5L12 14Z"/><path d="M6.5 11.2V17c2.8 2.2 8.2 2.2 11 0v-5.8M20.5 9v6"/>',
  shield: '<path d="M12 3 4 6v5c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  situation: '<path d="M8.8 9.2 11 14.6M15.2 9.2 13 14.6M9.7 7.6h4.6"/><circle cx="7.2" cy="7.2" r="3.15" fill="currentColor" stroke="none"/><circle cx="16.8" cy="7.2" r="3.15" fill="currentColor" stroke="none"/><circle cx="12" cy="17" r="3.35" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  wifi: '<path d="M2 8.8a16 16 0 0 1 20 0M5 12.4a11 11 0 0 1 14 0M8.5 16a6 6 0 0 1 7 0M12 20h.01"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
});

export function iconMarkup(name, { className = "", size = 18, title = "" } = {}) {
  const path = PATHS[name] || PATHS.info;
  const classes = `lw-icon${className ? ` ${className}` : ""}`;
  const titleMarkup = title ? `<title>${String(title).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]))}</title>` : "";
  return `<svg class="${classes}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${titleMarkup}${path}</svg>`;
}

export function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((element) => {
    const name = element.dataset.icon;
    const size = Number(element.dataset.iconSize || 18);
    element.innerHTML = iconMarkup(name, { size });
    element.setAttribute("aria-hidden", "true");
  });
}
