import assert from 'node:assert/strict';
import { extractDeadlineTracks, selectOpenSubmissionTrack, extractDeadline } from '../lib/webDiscovery.js';

const now = new Date('2026-07-12T12:00:00Z');
const automl = `
Main paper submission deadline: May 14, 2026.
Hot-off-the-Press and Late-Breaking paper submission deadline: July 15, 2026.
Main paper camera-ready deadline: July 30, 2026.
Author registration deadline: August 2, 2026.
`;
const tracks = extractDeadlineTracks(automl, now);
assert(tracks.some(x => x.type === 'camera_ready' && x.date.toISOString().startsWith('2026-07-30')));
assert(tracks.some(x => x.type === 'late_breaking_submission' && x.date.toISOString().startsWith('2026-07-15')));
const selected = selectOpenSubmissionTrack(tracks, now);
assert.equal(selected.type, 'late_breaking_submission');
assert(selected.date.toISOString().startsWith('2026-07-15'));
assert(extractDeadline(automl, now).toISOString().startsWith('2026-07-15'));

const closed = `Paper submission deadline: May 1, 2026. Camera-ready: August 1, 2026.`;
assert.equal(extractDeadline(closed, now), null, 'camera-ready must never make a closed CFP look open');

const main = `Full paper submission deadline: August 7, 2026. Notification: September 1, 2026.`;
assert(extractDeadline(main, now).toISOString().startsWith('2026-08-07'));

const aoe = `AOE) Full Paper Due: Friday, 31 July 2026 (11:59 p.m. Anywhere on Earth).`;
assert.equal(
  extractDeadline(aoe, now).toISOString(),
  "2026-08-01T11:59:00.000Z",
  "AoE deadlines must be stored as UTC-12 before localization"
);

console.log('deadline classification tests passed');

const { extractSubmissionOpening } = await import("../lib/webDiscovery.js");
const openingFuture = extractSubmissionOpening("Submissions open on August 1, 2026. Submission deadline September 1, 2026.", new Date("2026-07-13T12:00:00Z"));
assert.equal(openingFuture.isOpenNow, false);
const openingNow = extractSubmissionOpening("Submissions are now open. Submission deadline August 1, 2026.", new Date("2026-07-13T12:00:00Z"));
assert.equal(openingNow.isOpenNow, true);
const openingClosed = extractSubmissionOpening("Submissions are closed. Camera-ready deadline August 1, 2026.", new Date("2026-07-13T12:00:00Z"));
assert.equal(openingClosed.isOpenNow, false);
