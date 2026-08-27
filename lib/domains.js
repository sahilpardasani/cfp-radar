/**
 * Collapses the many fine-grained `domain` strings into a short list of macro
 * domains for the dashboard filter, so the dropdown stays readable.
 */
const RULES = [
  [/comput.*vision|vision|image|document ai|pattern recognition/i, "Computer Vision"],
  [/nlp|natural language|language|speech|audio|signal|linguistic/i, "NLP & Speech"],
  [/robot/i, "Robotics"],
  [/data|mining|information retrieval|web|database|knowledge|graph/i, "Data, Web & IR"],
  [/system|architecture|hpc|storage|network|cloud|systems/i, "Systems & Architecture"],
  [/secur|privacy|crypto/i, "Security & Privacy"],
  [/human-computer|hci|interface|interaction/i, "HCI"],
  [/theory|learning theory|mathematic|statistic/i, "Theory & Statistics"],
  [
    /medical|health|clinical|education|finance|hospitality|tourism|senior|population|iot|federated|blockchain|responsible|fairness|affective|social|environment|energy/i,
    "Applied & Responsible AI",
  ],
  [/machine learning|artificial intelligence|deep learning|neural|multi-agent|agent|reinforcement|evolutionary|ml systems|intelligent/i, "Machine Learning & AI"],
];

export function macroDomain(domain) {
  const d = domain || "";
  for (const [re, label] of RULES) if (re.test(d)) return label;
  return "Other";
}

export const MACRO_DOMAINS = [
  "Machine Learning & AI",
  "Computer Vision",
  "NLP & Speech",
  "Data, Web & IR",
  "Systems & Architecture",
  "Robotics",
  "Security & Privacy",
  "HCI",
  "Theory & Statistics",
  "Applied & Responsible AI",
  "Other",
];
