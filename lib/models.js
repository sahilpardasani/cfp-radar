/**
 * Catalog of selectable models for the Paper → Venue tab.
 * All NVIDIA entries use the same OpenAI-compatible endpoint
 * (https://integrate.api.nvidia.com/v1) and need NVIDIA_API_KEY.
 * The Groq entry is the free default and needs GROQ_API_KEY.
 *
 * `bodyExtra` is merged into the request body for models that take extra flags.
 */
export const MODELS = [
  {
    id: "qwen/qwen3.8-27b",
    label: "Qwen 3.8 27B (Groq) — recommended",
    provider: "groq",
    bodyExtra: { reasoning_effort: "none" },
  },
  { id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B (NVIDIA)", provider: "nvidia" },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B (NVIDIA)", provider: "nvidia" },
  { id: "z-ai/glm-5.2", label: "GLM 5.2 (NVIDIA)", provider: "nvidia" },
  { id: "minimaxai/minimax-m3", label: "MiniMax-M3 (NVIDIA)", provider: "nvidia" },
  {
    id: "deepseek-ai/deepseek-v4-pro",
    label: "DeepSeek V4 Pro (NVIDIA)",
    provider: "nvidia",
    bodyExtra: { chat_template_kwargs: { thinking: false } },
  },
  { id: "google/gemma-4-31b-it", label: "Gemma 4 31B (NVIDIA)", provider: "nvidia" },
  { id: "qwen/qwen3.5-397b-a17b", label: "Qwen 3.5 397B (NVIDIA)", provider: "nvidia" },
  {
    id: "mistralai/mistral-large-3-675b-instruct-2512",
    label: "Mistral Large 3 (NVIDIA)",
    provider: "nvidia",
  },
];

export const DEFAULT_MODEL_ID = MODELS[0].id;

export function findModel(id) {
  return MODELS.find((m) => m.id === id) || null;
}

/**
 * Publisher journal-suggester tools. Selecting one in the dropdown switches the tab
 * to "paste your abstract" mode and opens the publisher's own journal finder.
 */
export const SUGGESTERS = [
  {
    id: "finder-tf",
    label: "Taylor & Francis — Journal Suggester",
    publisher: "Taylor & Francis",
    url: "https://authorservices.taylorandfrancis.com/publishing-your-research/choosing-a-journal/journal-suggester/",
  },
  {
    id: "finder-elsevier",
    label: "Elsevier — JournalFinder",
    publisher: "Elsevier",
    url: "https://journalfinder.elsevier.com",
  },
  {
    id: "finder-wiley",
    label: "Wiley — Journal Finder",
    publisher: "Wiley",
    url: "https://www.wiley.com/en-us/journal-finder/",
  },
];

export function findSuggester(id) {
  return SUGGESTERS.find((s) => s.id === id) || null;
}
