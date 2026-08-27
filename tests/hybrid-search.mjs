import assert from "node:assert/strict";
import { hybridSearch, parseHybridQuery } from "../lib/hybridSearch.js";

const now = new Date("2026-07-14T12:00:00-04:00");
const items = [
  {
    id: "responsible-ai",
    name: "Conference on Responsible and Explainable Artificial Intelligence",
    acronym: "RAI",
    type: "conference",
    domain: "Artificial Intelligence",
    topics: ["algorithmic fairness", "AI accountability", "explainable AI"],
    deadline: "2026-09-20T23:59:00-04:00",
    legitimacy: { level: "trusted" },
  },
  {
    id: "generic-ai",
    name: "General Artificial Intelligence Symposium",
    acronym: "GAIS",
    type: "conference",
    domain: "Artificial Intelligence",
    topics: ["machine learning"],
    deadline: "2026-10-01T23:59:00-04:00",
    legitimacy: { level: "trusted" },
  },
  {
    id: "soon",
    name: "Trustworthy Systems Workshop",
    acronym: "TSW",
    type: "workshop",
    domain: "Artificial Intelligence",
    topics: ["AI safety"],
    deadline: "2026-07-30T23:59:00-04:00",
    legitimacy: { level: "trusted" },
  },
  {
    id: "rolling-book",
    name: "AI and Society Book Proposals",
    type: "book-proposal",
    publisher: "University Press",
    domain: "Responsible AI",
    rolling: true,
    legitimacy: { level: "trusted" },
  },
];

const prompt = "My work is on trustworthy AI and I need a deadline that is at least a month away";
const parsed = parseHybridQuery(prompt, { now });
assert.equal(parsed.semanticText, "trustworthy ai");
assert.equal(parsed.constraints.minDeadline.toISOString(), "2026-08-14T16:00:00.000Z");
assert.deepEqual(
  parseHybridQuery("books or chapters about AI", { now }).constraints.types.sort(),
  ["book-proposal", "chapter-proposal"],
  "a natural-language query may request multiple opportunity types"
);
const lessThanThirtyDays = parseHybridQuery("Deadline in less than 30 days", { now });
assert.equal(lessThanThirtyDays.constraints.maxDeadline.toISOString(), "2026-08-13T15:59:59.999Z");

const promptResults = hybridSearch(items, prompt, { now });
assert.deepEqual(promptResults.items.map((item) => item.id), ["responsible-ai"]);
assert.match(promptResults.interpretation, /deadline on\/after/);
assert.equal(promptResults.ranking, "bm25-semantic-constraints");

assert.deepEqual(
  hybridSearch(items, "explainable", { now }).items.map((item) => item.id),
  ["responsible-ai"],
  "plain keyword search remains supported"
);

assert.deepEqual(
  hybridSearch(items, "workshops on AI with a deadline at least one week away", { now }).items.map((item) => item.id),
  ["soon"],
  "type and relative-deadline intent are hard constraints"
);

assert.deepEqual(
  hybridSearch(items, "Deadline in less than 30 days", { now }).items.map((item) => item.id),
  ["soon"],
  "maximum relative-deadline prompts work without requiring a topic"
);
assert.deepEqual(
  hybridSearch([
    { id: "later", deadline: "2026-08-01T12:00:00-04:00" },
    { id: "earlier", deadline: "2026-07-20T12:00:00-04:00" },
  ], "Deadline in less than 30 days", { now }).items.map((item) => item.id),
  ["earlier", "later"],
  "deadline-only prompts are ordered soonest first"
);

assert.deepEqual(
  hybridSearch(items, "rolling book proposals about AI", { now }).items.map((item) => item.id),
  ["rolling-book"],
  "rolling and opportunity-type prompts work without a finite deadline"
);

const changingCatalog = [...items, {
  id: "new-ingested-call",
  name: "Newly Ingested Fair Machine Learning Special Issue",
  type: "special-issue",
  domain: "Machine Learning",
  topics: ["fairness", "robustness"],
  deadline: "2026-12-01T23:59:00-05:00",
}];
assert.equal(
  hybridSearch(changingCatalog, "fair machine learning", { now }).items[0].id,
  "new-ingested-call",
  "new cards are searched from their runtime content without per-source configuration"
);

const bm25Corpus = [
  {
    id: "focused-graph",
    name: "Graph Learning Workshop",
    type: "workshop",
    topics: ["graph learning", "graph neural networks"],
    deadline: "2026-11-01T23:59:00-04:00",
  },
  {
    id: "long-generic",
    name: "Broad Machine Learning Conference",
    type: "conference",
    description: `${"machine learning systems applications evaluation datasets methods ".repeat(30)} graph learning`,
    deadline: "2026-11-01T23:59:00-04:00",
  },
];
assert.equal(
  hybridSearch(bm25Corpus, "graph learning", { now }).items[0].id,
  "focused-graph",
  "BM25 length normalization favors the focused record over a long generic card"
);

console.log("hybrid search tests passed");
