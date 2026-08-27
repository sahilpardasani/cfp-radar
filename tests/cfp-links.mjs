import assert from "node:assert/strict";
import fs from "node:fs";
import { isWorkshopProposalUrl, primaryCfpUrl } from "../lib/cfpLinks.js";

const catalog = JSON.parse(fs.readFileSync("data/catalog-config.json", "utf8"));
const store = JSON.parse(fs.readFileSync("data/cfps.json", "utf8"));

assert.equal(isWorkshopProposalUrl("https://example.org/CallForWorkshops", catalog.linkPolicy), true);
assert.equal(primaryCfpUrl({
  type: "workshop",
  cfpUrl: "https://example.org/call-for-workshops",
  url: "https://workshop.example.org/call-for-papers",
}, catalog.linkPolicy), "https://workshop.example.org/call-for-papers");
assert.equal(primaryCfpUrl({ type: "conference", cfpUrl: "javascript:alert(1)" }, catalog.linkPolicy), null);
assert.equal(primaryCfpUrl({
  type: "conference",
  officialCfpUrl: "https://cpl2026.sites.uu.nl/",
  cfpUrl: "https://openreview.net/group?id=UU.nl/Utrecht_University/2026/CPL",
  url: "https://openreview.net/group?id=UU.nl/Utrecht_University/2026/CPL",
}, catalog.linkPolicy), "https://cpl2026.sites.uu.nl/");

const crossedLinks = store.items.filter((item) =>
  item.type === "workshop" && isWorkshopProposalUrl(item.cfpUrl, catalog.linkPolicy)
);
assert.deepEqual(crossedLinks.map((item) => item.id), [], "workshop-paper entries must not point to organizer calls");
assert.equal(catalog.linkPolicy.labels["workshop-directory"], "View workshop directory →");

for (const item of store.items) {
  const url = primaryCfpUrl(item, catalog.linkPolicy);
  assert.ok(url || (!item.cfpUrl && !item.url), `${item.id} has no safe CFP URL`);
}

console.log(`CFP link policy OK: ${store.items.length} entries checked.`);
