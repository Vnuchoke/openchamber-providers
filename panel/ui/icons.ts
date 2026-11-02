/** Small inline Remix outlines. Only glyphs the panel actually paints. */

const PATHS: Record<string, string> = {
  plus: 'M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z',
  search: 'M18.031 16.617l4.283 4.282-1.415 1.415-4.282-4.283A8.96 8.96 0 0 1 11 20c-4.968 0-9-4.032-9-9s4.032-9 9-9 9 4.032 9 9a8.96 8.96 0 0 1-1.969 5.617zm-2.006-.742A6.977 6.977 0 0 0 18 11c0-3.868-3.133-7-7-7-3.868 0-7 3.132-7 7 0 3.867 3.132 7 7 7a6.977 6.977 0 0 0 4.875-1.975z',
  chevronRight: 'M13.172 12l-4.95-4.95 1.414-1.413L16 12l-6.364 6.363-1.414-1.414z',
  chevronLeft: 'M10.828 12l4.95 4.95-1.414 1.413L8 12l6.364-6.363 1.414 1.414z',
  more: 'M12 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm-7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm14 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  trash: 'M7 4V2h10v2h5v2h-2v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6H2V4h5zm2 0h6V3H9v1zM6 6v13h12V6H6zm3 3h2v7H9V9zm4 0h2v7h-2V9z',
  check: 'M10 15.172l9.192-9.193 1.415 1.414L10 18l-6.364-6.364 1.414-1.414z',
  refresh: 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z',
  arrowLeft: 'M7.828 11H20v2H7.828l5.364 5.364-1.414 1.414L4 12l7.778-7.778 1.414 1.414z',
  code: 'M16.95 8.464l2.828 2.829-2.828 2.828-1.415-1.414L16.95 11.29l-1.415-1.414 1.415-1.412zM7.05 8.464L8.464 9.876 7.05 11.29l1.414 1.415-2.828-2.828L7.05 8.464z',
  close: 'M12 10.586l4.95-4.95 1.414 1.414-4.95 4.95 4.95 4.95-1.414 1.414-4.95-4.95-4.95 4.95-1.414-1.414 4.95-4.95-4.95-4.95 1.414-1.414z',
  warning: 'M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10-4.477 10-10 10zm0-2a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm-1-5h2v2h-2v-2zm0-8h2v6h-2V7z',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export const icon = (name: keyof typeof PATHS, size = 14): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', PATHS[name]!);
  svg.append(path);
  return svg;
};

export type IconName = keyof typeof PATHS;
