import assert from 'node:assert/strict';
import { parseOpenReviewHomepageText } from '../lib/openreviewHomepageText.js';

const text = `
Open Peer Review
Active Venues
Old 2022 Conference
Open for Submissions
COLM 2026 Workshop LSEI
Due 13 Jul 2026 at 07:59 Eastern Daylight Time
EMNLP 2026 Workshop LMP
Due 13 Jul 2026 at 09:00 Eastern Daylight Time
COLM 2026 Workshop GenAI4World Authors
Open for Submissions
Footer
`;
const anchors = [
  { text: 'Old 2022 Conference', href: 'https://openreview.net/group?id=Old/2022' },
  { text: 'COLM 2026 Workshop LSEI', href: 'https://openreview.net/group?id=COLM.cc/2026/Workshop/LSEI' },
  { text: 'EMNLP 2026 Workshop LMP', href: 'https://openreview.net/group?id=EMNLP/2026/Workshop/LMP' },
  { text: 'COLM 2026 Workshop GenAI4World Authors', href: 'https://openreview.net/group?id=COLM.cc/2026/Workshop/GenAI4World/Authors' },
];
const entries = parseOpenReviewHomepageText(text, anchors);
assert.equal(entries.length, 3);
assert.equal(entries[0].title, 'COLM 2026 Workshop LSEI');
assert.ok(entries[0].deadline);
assert.equal(entries[2].status, 'open');
assert.ok(!entries.some((e) => e.title.includes('2022')));
console.log('OpenReview visible-text homepage parser test passed');
