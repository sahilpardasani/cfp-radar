import fs from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), "data", "catalog-config.json");

const FALLBACK = {
  venueTypes: [
    { key: "conference", label: "Conferences", singular: "Conference" },
    { key: "workshop", label: "Workshops", singular: "Workshop" },
    { key: "journal", label: "Journals", singular: "Journal" },
    { key: "special-issue", label: "Special Issues", singular: "Special Issue" },
  ],
  sourceLabels: {},
  rankingSystems: {},
  linkPolicy: { workshopProposalPathPatterns: [] },
};

export function readCatalogConfig() {
  try {
    return { ...FALLBACK, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    return FALLBACK;
  }
}
