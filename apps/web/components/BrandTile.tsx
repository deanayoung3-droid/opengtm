/**
 * The app's logo tile (the same artwork as app/icon.svg and docs/assets/icon.svg): a "go" triangle
 * overlapping a circle, the lead. Static markup, so it is rendered as-is.
 */
const TILE = '<defs><linearGradient id="gtmTileBg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c6cff"/><stop offset="1" stop-color="#2a8cff"/></linearGradient><linearGradient id="gtmTileHi" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect width="100" height="100" rx="24" fill="url(#gtmTileBg)"/><g transform="translate(16 17) scale(.68)"><defs><clipPath id="gtmTileTrim"><path d="M21.00 19.48Q8.00 12.00 8.00 27.00L8.00 73.00Q8.00 88.00 21.00 80.52L61.00 57.48Q74.00 50.00 61.00 42.52Z"/></clipPath></defs>\n<path d="M21.00 19.48Q8.00 12.00 8.00 27.00L8.00 73.00Q8.00 88.00 21.00 80.52L61.00 57.48Q74.00 50.00 61.00 42.52Z" fill="#ffffff"/><path d="M42 50a26 26 0 1 0 52 0a26 26 0 1 0 -52 0Z" fill="#ffffff" fill-opacity=".62"/><path d="M42 50a26 26 0 1 0 52 0a26 26 0 1 0 -52 0Z" fill="url(#gtmTileBg)" clip-path="url(#gtmTileTrim)"/></g>\n<rect width="100" height="100" rx="24" fill="url(#gtmTileHi)"/><rect x=".5" y=".5" width="99" height="99" rx="23.5" fill="none" stroke="#000" stroke-opacity=".08"/>';

export function BrandTile({ size = 28, className }: { size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className={className} dangerouslySetInnerHTML={{ __html: TILE }} />;
}
