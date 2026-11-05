import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The company's logo for email signatures, as base64 PNG: the files named in business.yaml (company.logo,
 * and company.logo_dark for mail apps in dark mode), embedded in each email so nothing is fetched when it
 * is opened. Null when not set: emails then carry no logo.
 */
export interface BrandLogos {
  light: string | null;
  dark: string | null;
}

export const NO_LOGOS: BrandLogos = { light: null, dark: null };

/** Read the logo files (paths relative to the config folder). A missing file is a config error, not a silent gap. */
export function readLogos(configDir: string, light: string, dark: string): BrandLogos {
  const read = (file: string) => {
    if (!file.trim()) return null;
    const p = path.resolve(configDir, file.trim());
    if (!/\.png$/i.test(p)) throw new Error(`business.yaml: company logo must be a .png file (${file})`);
    return readFileSync(p).toString("base64");
  };
  return { light: read(light), dark: read(dark) };
}
