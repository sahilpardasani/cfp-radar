const TOPIC_RULES = [
  ["human–AI interaction", /human[- ](?:ai|robot)|human computer|interaction|user experience|interface|usability/i],
  ["AI & machine learning", /artificial intelligence|machine learning|deep learning|neural|transformer|language model|\bllm\b/i],
  ["affective computing", /emotion|affective|stress|sentiment|mental health/i],
  ["computer vision", /vision|image|video|visual|gaze|object detection|scene/i],
  ["health & assistive technology", /health|medical|clinical|cardiac|ecg|eeg|assistive|rehabilitation|disab|accessib/i],
  ["privacy, trust & security", /privacy|security|trust|ethical|fairness|explainab|responsib|password|federated/i],
  ["XR & multimodal interaction", /virtual reality|augmented reality|mixed reality|\bxr\b|multimodal|gesture|haptic/i],
  ["robotics", /robot|autonomous|drone/i],
  ["language & conversational systems", /language|speech|chatbot|conversation|text|hate speech|retrieval.augmented/i],
  ["education & learning", /education|learning environment|student|teaching|pedagog/i],
  ["sustainability & society", /sustainab|climate|esg|social|community|culture/i],
];

const METHOD_RULES = [
  ["user study", /user study|usability|participants?|questionnaire|interview|human evaluation/i],
  ["controlled experiment", /experiment|evaluation|comparative|assessment/i],
  ["qualitative study", /qualitative|thematic analysis|interview|ethnograph/i],
  ["survey or review", /systematic review|literature review|survey|mapping study/i],
  ["deep learning", /deep learning|neural network|cnn|transformer/i],
  ["LLM or generative AI", /language model|\bllm\b|generative|retrieval.augmented|\brag\b/i],
  ["privacy-preserving ML", /federated|differential privacy|privacy.preserving/i],
  ["multimodal modeling", /multimodal|image.text|audio.visual|sensor fusion/i],
  ["prototype or system", /system|framework|platform|application|interface|tool|architecture/i],
  ["case study", /case study|deployment|in the wild|real.world/i],
  ["dataset or benchmark", /dataset|benchmark|corpus/i],
];

function infer(text, rules) {
  return rules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

export function classifyPaper(title = "", abstract = "") {
  const text = `${title} ${abstract}`;
  return {
    topics: infer(text, TOPIC_RULES),
    methodTags: infer(text, METHOD_RULES),
    evidence: abstract ? "title-and-abstract" : "title-only",
  };
}

function counts(items, field) {
  const result = new Map();
  for (const item of items) {
    for (const value of item[field] || []) result.set(value, (result.get(value) || 0) + 1);
  }
  return [...result.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function buildVenueInsights(venueId, papers, editions) {
  const years = editions.map((edition) => edition.eventYear).filter(Number.isFinite).sort();
  return {
    venueId,
    startYear: years[0] || null,
    endYear: years.at(-1) || null,
    paperCount: papers.length,
    themes: counts(papers, "topics"),
    methods: counts(papers, "methodTags"),
    extractionEvidence: papers.some((paper) => paper.abstract) ? "title-and-abstract" : "title-only",
    generatedAt: new Date().toISOString(),
  };
}

export const TAXONOMY = {
  topics: TOPIC_RULES.map(([label]) => label),
  methods: METHOD_RULES.map(([label]) => label),
};
