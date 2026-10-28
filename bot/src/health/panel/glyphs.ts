// Track AP (docs/panel.md "Inventory"): the hand-drawn item glyphs of the panel, one inline SVG
// <symbol> each (16 x 16, `currentColor` = the item's colour from inventory.ts itemColour). The
// fallback of the real icons (icons/, decision 0046) for an item without a picture; nothing from the
// internet: the whole set is about 3 KB of the page.
import type { IconClass } from './inventory.ts';

const D = 'fill="#000" fill-opacity=".28"'; // shade
const L = 'fill="#fff" fill-opacity=".3"'; // highlight
const WOOD = 'fill="#8b5a2b"';

/** The inner SVG of each glyph. */
export const GLYPHS: Readonly<Record<IconClass, string>> = {
  sword: `<path d="M13.6 1H15v1.4L7.2 10.2 5.8 8.8z"/><path ${L} d="M14.3 1.2l.5.5-7.6 7.6-.5-.5z"/><path d="M3.4 8.6l4 4-1.1 1.1-1.2-1.2L3 14.6 1.4 13l2.1-2.1-1.2-1.2z" ${WOOD}/>`,
  pickaxe: `<path d="M2.2 3.6C5.6 1.3 10.6 1.4 14 4l-1.2 1.4C10.4 3.6 7.6 3.1 4.6 3.9z"/><path d="M8.6 4.6l1.5 1.4-7 8.6-1.6-1.4z" ${WOOD}/>`,
  axe: `<path d="M10.2 3.4l1.4 1.4-8.1 9.9L2 13.3z" ${WOOD}/><path d="M8.4 2.6c1.9-1.6 4.6-1.6 6.4.4-.9 2.6-2.9 4.2-5 4.7z"/><path ${D} d="M9.8 6.8l4-3.4.7.6c-1.1 1.9-2.8 3.2-4.7 3.6z"/>`,
  shovel: `<path d="M9.4 5.4l1.3 1.3-7.5 7.9L2 13.3z" ${WOOD}/><path d="M10.2 1.4c1.4-.9 3.5.7 4.4 2.3.7 1.1-1.3 3.1-2.9 3.8L8.4 4.6c.5-1.4.9-2.6 1.8-3.2z"/>`,
  hoe: `<path d="M11.2 2.6l1.4 1.4-9.1 10.8L2 13.4z" ${WOOD}/><path d="M8.6 1H15v2.2h-3.4l-1.1-1H8.6z"/>`,
  bow: `<path d="M3.5 1c6.2 1.7 10.2 5.8 11.5 11.5h-1.7C12.2 7.6 8.6 4.1 3.5 2.7z"/><path d="M3.6 2.2l11 11-.6.6-11-11z" fill="#ddd"/><path d="M3 1.5l1.8.2-.3 1.8z" ${WOOD}/>`,
  shield: `<path d="M8 1l6 2.2v4.3c0 3.9-2.6 6.4-6 7.9-3.4-1.5-6-4-6-7.9V3.2z"/><path ${L} d="M8 2.3v12c-2.6-1.3-4.6-3.4-4.6-6.7V4.1z"/>`,
  helmet: `<path d="M2 10C2 5 4.7 2 8 2s6 3 6 8v3h-3V9.5H5V13H2z"/><path ${L} d="M3.4 7C4 4.6 5.7 3.3 8 3.3V5C6.2 5 5 6 4.6 7.6z"/>`,
  chestplate: `<path d="M1 4.3L5 2c.7 1.2 1.7 1.9 3 1.9s2.3-.7 3-1.9l4 2.3-1.5 4H12V14H4V8.3H2.5z"/><path ${D} d="M8 5.2v8.8H6V6z"/>`,
  leggings: `<path d="M3 2h10v4l-1 8H9.2L8 7.4 6.8 14H4L3 6z"/><path ${D} d="M3 2h10v1.6H3z"/>`,
  boots: `<path d="M2 5h4v5.5h2V14H2zM9 5h4v5.5h2V14H9z"/><path ${D} d="M2 12.6h6V14H2zM9 12.6h6V14H9z"/>`,
  food: `<path d="M8 4.2c-2-1.5-6-1-6 4 0 3.4 2.4 6.8 4.4 6.8.7 0 1-.4 1.6-.4s.9.4 1.6.4c2 0 4.4-3.4 4.4-6.8 0-5-4-5.5-6-4z"/><path d="M7.5 4.3c0-1.6.7-2.8 2.2-3.3l.6.9C9 2.5 8.7 3.3 8.6 4.4z" ${WOOD}/><path ${L} d="M4 6.5c.4-1 1.2-1.5 2-1.6l.2 1C5.6 6 5.2 6.4 5 7z"/>`,
  block: `<path d="M8 1l7 3.5v7.8L8 15.8l-7-3.5V4.5z"/><path ${L} d="M8 1l7 3.5L8 8 1 4.5z"/><path ${D} d="M8 8v7.8l-7-3.5V4.5z"/>`,
  ore: `<rect x="1" y="1" width="14" height="14" rx="2" fill="#7f8389"/><path d="M3 3h3v3H3zM9.5 4.5h3v3h-3zM4.5 10h3v3h-3zM11 11h2.2v2.2H11z"/>`,
  box: `<rect x="1" y="6" width="14" height="9" rx="1.2"/><rect x="1" y="1.5" width="14" height="5.5" rx="1.2"/><path ${L} d="M1 1.5h14V4H1z"/><path ${D} d="M1 6.5h14V8H1zM6.5 8.5h3V11h-3z"/>`,
  bucket: `<path d="M2 5h12l-1.5 9.6h-9z" fill="#aab0b8"/><path d="M2.6 5h10.8l-.4 2.6H3z"/><path d="M3 5C3 1.4 13 1.4 13 5h-1.3c0-2-7.4-2-7.4 0z" fill="#8d939b"/>`,
  torch: `<path d="M7 7h2v8H7z" ${WOOD}/><path d="M8 1c2 1.9 2.6 3.6 1.5 5.8h-3C5.4 4.6 6 2.9 8 1z" fill="#ffb02e"/><path d="M8 3.3c.9.9 1.1 1.9.6 3H7.4c-.5-1.1-.3-2.1.6-3z" fill="#fff3b0"/>`,
  item: `<rect x="2" y="2" width="12" height="12" rx="3"/><path ${L} d="M2 5c0-1.7 1.3-3 3-3h6c1.7 0 3 1.3 3 3z"/>`,
};

/** The hidden <svg> with every glyph as a <symbol id="g-<class>">. */
export function glyphDefs(): string {
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${Object.entries(GLYPHS)
    .map(([k, v]) => `<symbol id="g-${k}" viewBox="0 0 16 16">${v}</symbol>`)
    .join('')}</svg>`;
}
