import assert from 'node:assert/strict';
import { parseOpenReviewDue } from '../lib/openreviewDirectory.js';
const future = parseOpenReviewDue('Due 30 Mar 2027 at 20:00 Eastern Daylight Time');
const past = parseOpenReviewDue('Due 30 Mar 2022 at 20:00 Eastern Daylight Time');
assert.ok(new Date(future).getTime() > new Date('2026-07-13').getTime());
assert.ok(new Date(past).getTime() < new Date('2026-07-13').getTime());
console.log('OpenReview browser deadline filter test passed');
