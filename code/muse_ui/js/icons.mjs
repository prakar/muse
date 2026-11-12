const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  star: [['polygon', { points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2' }]],
  note: [['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 2 14 8 20 8' }], ['line', { x1: 16, y1: 13, x2: 8, y2: 13 }], ['line', { x1: 16, y1: 17, x2: 8, y2: 17 }]],
  x: [['line', { x1: 18, y1: 6, x2: 6, y2: 18 }], ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]],
  left: [['polyline', { points: '15 18 9 12 15 6' }]], right: [['polyline', { points: '9 18 15 12 9 6' }]],
  search: [['circle', { cx: 11, cy: 11, r: 8 }], ['line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }]],
  copy: [['rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }], ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]],
  eye: [['path', { d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  'eye-off': [['path', { d: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24' }], ['line', { x1: 1, y1: 1, x2: 23, y2: 23 }]],
  layers: [['polygon', { points: '12 2 2 7 12 12 22 7 12 2' }], ['polyline', { points: '2 17 12 22 22 17' }], ['polyline', { points: '2 12 12 17 22 12' }]],
  basket: [['path', { d: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z' }]],
  link: [['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }], ['polyline', { points: '15 3 21 3 21 9' }], ['line', { x1: 10, y1: 14, x2: 21, y2: 3 }]],
  grid: [['rect', { x: 4, y: 4, width: 6, height: 6 }], ['rect', { x: 14, y: 4, width: 6, height: 6 }], ['rect', { x: 4, y: 14, width: 6, height: 6 }], ['rect', { x: 14, y: 14, width: 6, height: 6 }]],
  veins: [['path', { d: 'M12 3v8M12 11l-6 9M12 11l6 9' }]],
  grip: [['path', { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' }]],
  lone: [['circle', { cx: 12, cy: 12, r: 3 }]],
  loop: [['path', { d: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5' }]],
  shuffle: [['path', { d: 'M3 7h4l10 10h4M3 17h4l3-3M14 10l3-3h4' }]],
  differ: [['path', { d: 'M5 9h14M5 15h14M9 20l6-16' }]],
  drop: [['path', { d: 'M5 12h10M18 12h1' }]],
  sound: [['path', { d: 'M4 10v4h4l5 4V6l-5 4zM16 9a4 4 0 0 1 0 6' }]],
  toword: [['path', { d: 'M4 12h14M13 6l6 6-6 6' }]],
  reverse: [['path', { d: 'M20 12H6M11 6l-6 6 6 6' }]],
  digits: [['path', { d: 'M8 4l-2 16M18 4l-2 16M4 9h16M3 15h16' }]],
  back: [['line', { x1: 19, y1: 12, x2: 5, y2: 12 }], ['polyline', { points: '12 19 5 12 12 5' }]]
};
export function icon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  (ICONS[name] || []).forEach(([tag, attrs]) => { const n = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); svg.append(n); });
  return svg;
}
