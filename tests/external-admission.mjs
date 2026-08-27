import assert from "node:assert/strict";
import { externalAdmissionDecision } from "../lib/admissionPolicy.js";

const candidate = {
  type: "conference",
  deadline: "2026-08-01T00:00:00Z",
  cfpUrl: "https://conference.example.edu/2026/cfp",
  discoveryEvidence: { officialPage: "https://conference.example.edu/2026/cfp", deadlineFoundOnOfficialPage: true },
};
const vetted = {
  level: "trusted", evidenceQuality: "corroborated", score: 5,
  proceedings: { established: true }, publisherEvidence: {}, parentConference: {},
};
assert.equal(externalAdmissionDecision(candidate, vetted, new Date("2026-07-14")).admitted, true);
assert.equal(externalAdmissionDecision({ ...candidate, cfpUrl: "https://www.wikicfp.com/cfp/servlet/event.showcfp?id=1" }, vetted, new Date("2026-07-14")).admitted, false);
assert.equal(externalAdmissionDecision(candidate, { ...vetted, evidenceQuality: "partial" }, new Date("2026-07-14")).admitted, false);
assert.equal(externalAdmissionDecision({ ...candidate, deadline: "2026-07-01" }, vetted, new Date("2026-07-14")).admitted, false);
console.log("External admission policy tests passed.");
