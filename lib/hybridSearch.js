const DAY_MS = 24 * 60 * 60 * 1000;

const STOP_WORDS = new Set([
  "a", "about", "all", "am", "an", "and", "any", "are", "around", "at", "be", "for", "from",
  "give", "have", "i", "im", "in", "is", "it", "looking", "me", "my", "need", "of", "on", "or",
  "please", "show", "that", "the", "to", "want", "where", "which", "with", "work", "working",
]);

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
};

const TYPE_INTENTS = [
  { pattern: /\b(?:call(?:s)?\s+for\s+reviewers?|reviewer\s+(?:calls?|opportunities|applications?)|review\s+papers?)\b/i, types: ["reviewer-call"] },
  { pattern: /\bspecial\s+issues?\b/i, types: ["special-issue"] },
  { pattern: /\b(?:book|monograph)\s+proposals?\b|\bbooks?\b/i, types: ["book-proposal"] },
  { pattern: /\bchapter\s+proposals?\b|\bchapters?\b/i, types: ["chapter-proposal"] },
  { pattern: /\b(?:host|organize|organise|propose)\s+(?:a\s+)?workshops?\b|\bworkshop\s+proposals?\b/i, types: ["workshop-proposal"] },
  { pattern: /\bworkshops?\b/i, types: ["workshop"] },
  { pattern: /\bjournals?\b/i, types: ["journal", "special-issue"] },
  { pattern: /\bconferences?\b|\bvenues?\b/i, types: ["conference"] },
];

const SEMANTIC_GROUPS = [
  {
    label: "trustworthy AI",
    triggers: ["trustworthy ai", "responsible ai", "ethical ai", "ai safety"],
    phrases: ["trustworthy ai", "responsible ai", "ai safety", "explainable ai", "artificial intelligence ethics", "algorithmic fairness", "machine learning fairness", "robust machine learning", "ai accountability", "ai transparency", "ai governance", "privacy preserving machine learning", "xai"],
  },
  {
    label: "machine learning",
    triggers: ["machine learning", "ml"],
    phrases: ["machine learning", "deep learning", "neural networks", "representation learning", "foundation models"],
  },
  {
    label: "natural language processing",
    triggers: ["natural language processing", "nlp", "language models", "llm", "llms"],
    phrases: ["natural language processing", "computational linguistics", "language model", "large language model", "text mining", "nlp"],
  },
  {
    label: "computer vision",
    triggers: ["computer vision", "vision", "image understanding"],
    phrases: ["computer vision", "image processing", "medical imaging", "visual recognition", "multimodal learning"],
  },
  {
    label: "data science",
    triggers: ["data science", "data mining", "analytics"],
    phrases: ["data science", "data mining", "knowledge discovery", "data analytics", "big data", "database systems"],
  },
  {
    label: "cybersecurity",
    triggers: ["cybersecurity", "cyber security", "information security", "privacy"],
    phrases: ["cybersecurity", "computer security", "information security", "privacy", "cryptography", "secure systems"],
  },
  {
    label: "human-computer interaction",
    triggers: ["human computer interaction", "hci", "human ai interaction"],
    phrases: ["human computer interaction", "human ai interaction", "user experience", "interactive systems", "social computing", "hci"],
  },
  {
    label: "AI for health",
    triggers: ["ai for health", "health ai", "medical ai", "clinical ai"],
    phrases: ["health ai", "medical ai", "clinical ai", "biomedical informatics", "medical imaging", "digital health", "healthcare"],
  },
];

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+#./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalize(value)
    .split(" ")
    .map((token) => token.replace(/^[./-]+|[./-]+$/g, ""))
    .filter((token) => token && !STOP_WORDS.has(token) && (token.length > 1 || /\d/.test(token)));
}

function addDuration(date, amount, unit) {
  const result = new Date(date);
  if (unit.startsWith("month")) result.setMonth(result.getMonth() + amount);
  else if (unit.startsWith("year")) result.setFullYear(result.getFullYear() + amount);
  else result.setTime(result.getTime() + amount * (unit.startsWith("week") ? 7 : 1) * DAY_MS);
  return result;
}

function durationAmount(raw) {
  return NUMBER_WORDS[normalize(raw)] || Number.parseInt(raw, 10) || 1;
}

function parseNamedDate(raw, now) {
  const hasYear = /\b\d{4}\b/.test(raw);
  let parsed = new Date(hasYear ? raw : `${raw}, ${now.getFullYear()}`);
  if (!Number.isFinite(parsed.getTime())) return null;
  if (!hasYear && parsed < now) parsed = new Date(`${raw}, ${now.getFullYear() + 1}`);
  return parsed;
}

export function parseHybridQuery(query, { now = new Date() } = {}) {
  const raw = String(query || "").trim();
  const normalized = normalize(raw).replace(/\batleast\b/g, "at least");
  let semanticText = normalized;
  const constraints = { minDeadline: null, maxDeadline: null, maxDeadlineExclusive: false, types: [], trustedOnly: false, rollingOnly: false };

  const minDuration = /(?:\bat\s+least\b|\bminimum\s+of\b|\bmore\s+than\b|\bno\s+sooner\s+than\b)\s+(a|an|\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(day|week|month|year)s?(?:\s+(?:away|from\s+now))?/i.exec(normalized);
  if (minDuration) {
    constraints.minDeadline = addDuration(now, durationAmount(minDuration[1]), minDuration[2]);
    semanticText = semanticText.replace(minDuration[0], " ");
  }

  const maxDuration = /(?:\bwithin\b|\bin\s+the\s+next\b|\bin\s+less\s+than\b|\bless\s+than\b|\bunder\b|\bno\s+more\s+than\b)\s+(?:the\s+next\s+)?(a|an|\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(day|week|month|year)s?/i.exec(normalized);
  if (maxDuration) {
    constraints.maxDeadline = addDuration(now, durationAmount(maxDuration[1]), maxDuration[2]);
    if (/\bless\s+than\b|\bunder\b/i.test(maxDuration[0])) {
      constraints.maxDeadlineExclusive = true;
      constraints.maxDeadline = new Date(constraints.maxDeadline.getTime() - 1);
    }
    semanticText = semanticText.replace(maxDuration[0], " ");
  }

  const datePattern = "((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+\\d{1,2}(?:,?\\s+\\d{4})?)";
  const afterDate = new RegExp(`(?:deadline\\s+)?(?:after|later\\s+than|no\\s+earlier\\s+than)\\s+${datePattern}`, "i").exec(normalized);
  if (afterDate) {
    constraints.minDeadline = parseNamedDate(afterDate[1], now);
    semanticText = semanticText.replace(afterDate[0], " ");
  }
  const beforeDate = new RegExp(`(?:deadline\\s+)?(?:before|earlier\\s+than|no\\s+later\\s+than)\\s+${datePattern}`, "i").exec(normalized);
  if (beforeDate) {
    constraints.maxDeadline = parseNamedDate(beforeDate[1], now);
    semanticText = semanticText.replace(beforeDate[0], " ");
  }

  if (/\brolling(?:\s+deadline|\s+calls?|\s+submissions?)?\b/i.test(normalized)) {
    constraints.rollingOnly = true;
    semanticText = semanticText.replace(/\brolling(?:\s+deadline|\s+calls?|\s+submissions?)?\b/gi, " ");
  }

  if (/\b(?:trusted|verified|legitimate)\s+(?:only|calls?|venues?|conferences?|journals?|publishers?)\b|\bonly\s+(?:trusted|verified|legitimate)\b/i.test(normalized)) {
    constraints.trustedOnly = true;
    semanticText = semanticText.replace(/\b(?:trusted|verified|legitimate)\s+(?:only|calls?|venues?|conferences?|journals?|publishers?)\b|\bonly\s+(?:trusted|verified|legitimate)\b/gi, " ");
  }

  for (const intent of TYPE_INTENTS) {
    if (!intent.pattern.test(normalized)) continue;
    if (intent.types.includes("workshop") && constraints.types.includes("workshop-proposal")) continue;
    constraints.types.push(...intent.types);
    semanticText = semanticText.replace(intent.pattern, " ");
  }
  constraints.types = [...new Set(constraints.types)];

  semanticText = semanticText
    .replace(/\b(?:deadline|deadlines|due|closing|closes|open|opportunities|opportunity|calls?|cfps?)\b/gi, " ")
    .replace(/\b(?:my\s+work\s+is|research\s+is|researching|interested\s+in|related\s+to)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  semanticText = tokenize(semanticText).join(" ");

  const matchedGroups = SEMANTIC_GROUPS.filter((group) =>
    group.triggers.some((trigger) => normalized.includes(normalize(trigger)))
  );

  return {
    raw,
    normalized,
    semanticText,
    terms: [...new Set(tokenize(semanticText))],
    semanticGroups: matchedGroups,
    constraints,
  };
}

function itemType(item) {
  if (item.type) return item.type;
  if (item.venue && item.role && /reviewer/i.test(item.role)) return "reviewer-call";
  if (item.reviewStatus) return "review";
  if (item.conference && /workshop/i.test(`${item.name || ""} ${item.requirements || ""}`)) return "workshop-proposal";
  return "";
}

function isTrusted(item) {
  if (item.reviewStatus || itemType(item) === "review") return false;
  const level = item.legitimacy?.level || item.integrity?.level || item.admission?.status;
  return !level || ["trusted", "admitted", "verified"].includes(String(level).toLowerCase());
}

function deadlineOf(item) {
  if (item.rolling) return null;
  const deadline = new Date(item.deadline || item.proposalDeadline || "");
  return Number.isFinite(deadline.getTime()) ? deadline : null;
}

function searchableFields(item) {
  const high = [item.acronym, item.name, item.conference, item.domain, item.publisher, ...(item.topics || [])];
  const body = [
    item.type, item.description, item.requirements, item.location, item.source, item.eventDates,
    item.submissionPlatform, item.series, ...(item.reviewReasons || []),
  ];
  return { high: normalize(high.filter(Boolean).join(" ")), body: normalize(body.filter(Boolean).join(" ")) };
}

function searchDocument(item, index) {
  const fields = searchableFields(item);
  const highTokens = tokenize(fields.high);
  const bodyTokens = tokenize(fields.body);
  return {
    item,
    index,
    fields,
    highTokens,
    bodyTokens,
    length: highTokens.length * 2.4 + bodyTokens.length,
  };
}

function termFrequency(tokens, term) {
  let count = 0;
  for (const token of tokens) if (token === term) count += 1;
  return count;
}

function queryTermWeights(parsed) {
  const weights = new Map(parsed.terms.map((term) => [term, 1]));
  for (const group of parsed.semanticGroups) {
    for (const phrase of group.phrases) {
      for (const term of tokenize(phrase)) {
        if (!weights.has(term)) weights.set(term, 0.32);
      }
    }
  }
  return weights;
}

function buildBm25Context(documents, parsed) {
  const queryWeights = queryTermWeights(parsed);
  const documentFrequency = new Map();
  for (const term of queryWeights.keys()) {
    documentFrequency.set(term, documents.reduce((count, doc) =>
      count + (doc.highTokens.includes(term) || doc.bodyTokens.includes(term) ? 1 : 0), 0
    ));
  }
  const averageLength = documents.length
    ? documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length
    : 1;
  return { queryWeights, documentFrequency, averageLength, size: documents.length };
}

function bm25Score(doc, parsed, context) {
  const k1 = 1.2;
  const b = 0.75;
  const lengthNormalization = k1 * (1 - b + b * (doc.length / Math.max(context.averageLength, 1)));
  let score = 0;

  for (const [term, queryWeight] of context.queryWeights) {
    const weightedTf = termFrequency(doc.highTokens, term) * 2.4 + termFrequency(doc.bodyTokens, term);
    if (!weightedTf) continue;
    const df = context.documentFrequency.get(term) || 0;
    const idf = Math.log(1 + (context.size - df + 0.5) / (df + 0.5));
    score += queryWeight * idf * ((weightedTf * (k1 + 1)) / (weightedTf + lengthNormalization));
  }

  // BM25 ranks terms well but does not preserve word order, so exact phrases get a modest boost.
  if (parsed.semanticText.length >= 3 && doc.fields.high.includes(parsed.semanticText)) score += 5;
  else if (parsed.semanticText.length >= 3 && doc.fields.body.includes(parsed.semanticText)) score += 2;

  for (const group of parsed.semanticGroups) {
    const phraseMatches = group.phrases.filter((phrase) =>
      `${doc.fields.high} ${doc.fields.body}`.includes(normalize(phrase))
    ).length;
    if (phraseMatches) score += 2 + Math.min(phraseMatches - 1, 3) * 0.75;
  }
  return score;
}

function matchesSemanticIntent(item, parsed) {
  if (!parsed.semanticGroups.length) return true;
  const fields = searchableFields(item);
  const combined = `${fields.high} ${fields.body}`;
  return parsed.semanticGroups.some((group) =>
    group.phrases.some((phrase) => combined.includes(normalize(phrase)))
  );
}

function matchesConstraints(item, parsed) {
  const { constraints } = parsed;
  if (constraints.types.length && !constraints.types.includes(itemType(item))) return false;
  if (constraints.trustedOnly && !isTrusted(item)) return false;
  if (constraints.rollingOnly && !item.rolling) return false;

  if (constraints.minDeadline || constraints.maxDeadline) {
    const deadline = deadlineOf(item);
    if (!deadline) return false;
    if (constraints.minDeadline && deadline < constraints.minDeadline) return false;
    if (constraints.maxDeadline && deadline > constraints.maxDeadline) return false;
  }
  return true;
}

function dateLabel(date) {
  return date?.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function interpretationOf(parsed) {
  const parts = [];
  if (parsed.semanticText) parts.push(`topic: ${parsed.semanticText}`);
  if (parsed.constraints.types.length) parts.push(`type: ${parsed.constraints.types.join(" or ").replace(/-/g, " ")}`);
  if (parsed.constraints.minDeadline) parts.push(`deadline on/after ${dateLabel(parsed.constraints.minDeadline)}`);
  if (parsed.constraints.maxDeadline) {
    parts.push(`${parsed.constraints.maxDeadlineExclusive ? "deadline before" : "deadline on/before"} ${dateLabel(parsed.constraints.maxDeadline)}`);
  }
  if (parsed.constraints.rollingOnly) parts.push("rolling calls only");
  if (parsed.constraints.trustedOnly) parts.push("trusted only");
  return parts.join(" · ");
}

export function hybridSearch(items, query, options = {}) {
  const parsed = parseHybridQuery(query, options);
  if (!parsed.raw) return { items: [...(items || [])], interpretation: "", parsed, ranking: "source-order" };

  const hasMeaning = parsed.terms.length > 0 || parsed.semanticGroups.length > 0;
  const eligibleDocuments = (items || [])
    .filter((item) => matchesConstraints(item, parsed) && matchesSemanticIntent(item, parsed))
    .map(searchDocument);
  const bm25Context = buildBm25Context(eligibleDocuments, parsed);
  const ranked = eligibleDocuments
    .map((doc) => ({ ...doc, score: bm25Score(doc, parsed, bm25Context) }))
    .filter(({ score }) => !hasMeaning || score > 0)
    .sort((a, b) => {
      if (hasMeaning) return b.score - a.score || a.index - b.index;
      const aDeadline = deadlineOf(a.item)?.getTime() ?? Number.POSITIVE_INFINITY;
      const bDeadline = deadlineOf(b.item)?.getTime() ?? Number.POSITIVE_INFINITY;
      return aDeadline - bDeadline || a.index - b.index;
    });

  return {
    items: ranked.map(({ item }) => item),
    interpretation: interpretationOf(parsed),
    parsed,
    ranking: hasMeaning ? "bm25-semantic-constraints" : "deadline-constraints",
  };
}
