// Iconos de línea propios (24×24, trazo con currentColor).
const P = {
  person:
    '<circle cx="12" cy="4.2" r="1.9"/><path d="M12 7.2v6.3M12 13.5l-3 7M12 13.5l3 7M12 9l-4 3M12 9l4 3"/>',
  bicycle:
    '<circle cx="5.5" cy="16" r="3.6"/><circle cx="18.5" cy="16" r="3.6"/><path d="M5.5 16l4-7.5h6.2l2.8 7.5M9.5 8.5L12 16h-6.5M15.7 8.5l-.9-2.3h-2.2"/>',
  motorcycle:
    '<circle cx="5.2" cy="16.3" r="3.3"/><circle cx="18.8" cy="16.3" r="3.3"/><path d="M5.2 16.3h6.3l3-5h3.2l1.1 5M14.5 11.3l-1.3-3h-2.3M8.4 11.3h4.2"/>',
  car:
    '<path d="M3 16.5v-3.2l2-4.6c.3-.7 1-1.2 1.8-1.2h10.4c.8 0 1.5.5 1.8 1.2l2 4.6v3.2z"/><path d="M5 12.6h14"/><circle cx="7.2" cy="16.8" r="1.9"/><circle cx="16.8" cy="16.8" r="1.9"/>',
  bus:
    '<rect x="4" y="3.5" width="16" height="14" rx="2.2"/><path d="M4 11h16M8 3.5v7.5M4 14.5h2M18 14.5h2"/><path d="M7 17.5v2.5M17 17.5v2.5"/>',
  truck:
    '<path d="M2.5 6h11v10.5h-11zM13.5 9.5h4.2l3.3 3.5v3.5h-7.5"/><circle cx="6.5" cy="17.5" r="1.9"/><circle cx="17" cy="17.5" r="1.9"/>',
  gauge:
    '<path d="M4.2 17.5a8.5 8.5 0 1 1 15.6 0"/><path d="M12 13.5l4-4.5"/><circle cx="12" cy="13.5" r="1.3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  pin: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  arrows: '<path d="M4 8h15l-3.5-3.5M20 16H5l3.5 3.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-3"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  layers: '<path d="M12 4l8.5 4.5L12 13 3.5 8.5z"/><path d="M3.5 12.5L12 17l8.5-4.5"/>',
}

export function icon(name, size = 22, extra = '') {
  return `<svg class="ico ${extra}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`
}
