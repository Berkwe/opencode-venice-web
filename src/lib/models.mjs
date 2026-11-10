/**
 * Models that venice.ai serves over the web on every plan, i.e. the models the
 * web catalogue flags as `usesCredits: false`. A Pro/Max subscription is
 * unlimited for these in the web chat, and the web inference endpoint does not
 * bill them to the API balance - which is the whole point of this proxy.
 *
 * Generated from the live web catalogue (`GET /api/app/models`, 2026-11-10):
 * ids and names are copied verbatim from the catalogue, no renaming.
 *
 * `reasoning: true` marks models that emit reasoning deltas. `context`/`output`
 * are the web catalogue limits, used to build the OpenCode model config.
 */
export const MODELS = {
  'deepseek-v4-1-flash-uncensored': { name: 'DeepSeek V4.1 Flash Uncensored', context: 524288, output: 131072, reasoning: true },
  'deepseek-v4-1-flash-1017': { name: 'DeepSeek 4.1 Flash 1017', context: 1000000, output: 131072, reasoning: true },
  'z-ai-glm-5-3-flash': { name: 'GLM 5.3 Flash', context: 1048576, output: 131072, reasoning: true },
  'zai-org-glm-5.2': { name: 'GLM 5.2', context: 1000000, output: 131072, reasoning: true },
  'zai-org-glm-5.1': { name: 'GLM 5.1', context: 200000, output: 80000, reasoning: false },
  'zai-org-glm-5': { name: 'GLM 5', context: 198000, output: 32000, reasoning: true },
  'olafangensan-glm-4.7-flash-heretic': { name: 'GLM 4.7 Flash Heretic', context: 200000, output: 24000, reasoning: false },
  'zai-org-glm-4.7-app': { name: 'GLM 4.7', context: 198000, output: 16384, reasoning: false },
  'venice-uncensored-1-2': { name: 'Venice Uncensored 1.2', context: 128000, output: 8192, reasoning: false },
  'venice-uncensored-role-play': { name: 'Venice Role Play Uncensored', context: 128000, output: 4096, reasoning: false },
  'qwen-3-8-27b': { name: 'Qwen 3.8 27B', context: 262144, output: 65536, reasoning: true },
  'qwen3-6-27b': { name: 'Qwen 3.6 27B', context: 256000, output: 65536, reasoning: true },
  'qwen3-5-35b-a3b': { name: 'Qwen 3.5 35B A3B', context: 256000, output: 16384, reasoning: true },
  'qwen3-vl-235b-a22b': { name: 'Qwen3 VL 235B', context: 128000, output: 16384, reasoning: false },
  'qwen3-coder-480b-a35b-instruct-turbo': { name: 'Qwen 3 Coder 480B Turbo', context: 256000, output: 65536, reasoning: true },
  'google-gemma-4-26b-a4b-it': { name: 'Google Gemma 4 26B A4B Instruct', context: 256000, output: 8192, reasoning: false },
  'google-gemma-4-31b-it': { name: 'Google Gemma 4 31B Instruct', context: 256000, output: 16384, reasoning: false },
  'deepseek-ai-DeepSeek-V3.2': { name: 'DeepSeek V3.2', context: 160000, output: 32768, reasoning: false },
  'aion-labs-aion-3-0': { name: 'Aion 3.0', context: 128000, output: 32768, reasoning: false },
  'aion-labs-aion-3-0-mini': { name: 'Aion 3.0 Mini', context: 128000, output: 32768, reasoning: false },
  'nvidia-nemotron-3-nano-30b-a3b': { name: 'NVIDIA Nemotron 3 Nano 30B', context: 128000, output: 16384, reasoning: false },
  'nvidia-nemotron-3-ultra-550b-a55b': { name: 'NVIDIA Nemotron 3 Ultra', context: 256000, output: 32768, reasoning: false },
  'e2ee-gemma-4-26b-a4b-uncensored-p': { name: 'Gemma 4 26B A4B Uncensored', context: 64000, output: 4096, reasoning: false },
  'e2ee-gpt-oss-120b-p': { name: 'GPT OSS 120B', context: 128000, output: 32768, reasoning: false },
  'e2ee-qwen-2-5-7b-p': { name: 'Qwen 2.5 7B', context: 32000, output: 4096, reasoning: false },
  'e2ee-qwen3-vl-30b-a3b-p': { name: 'Qwen3 VL 30B A3B', context: 128000, output: 4096, reasoning: false },
  'e2ee-qwen3-6-35b-a3b': { name: 'Qwen 3.6 35B A3B FP8', context: 32000, output: 4096, reasoning: true },
  'e2ee-qwen3-8-27b': { name: 'Qwen 3.8 27B', context: 262144, output: 8192, reasoning: true },
  'zai-org-glm-4.6': { name: 'GLM 4.6', context: 198000, output: 16384, reasoning: false },
  'gemma4-uncensored': { name: 'Gemma 4 Uncensored', context: 256000, output: 8192, reasoning: false },
}

/** Default model, used by the installer and `sync --default`. Unchanged. */
export const DEFAULT_MODEL = 'deepseek-v4-1-flash-free'

/** Cheap model for titles/summaries. */
export const DEFAULT_SMALL_MODEL = 'qwen3-5-35b-a3b'

export const modelIds = Object.keys(MODELS)
