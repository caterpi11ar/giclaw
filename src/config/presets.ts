export interface ProviderPreset {
  label: string
  value: string
  baseUrl: string
  modelName: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    label: 'Google Gemini (推荐)',
    value: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelName: 'gemini-2.5-flash',
  },
  {
    label: 'OpenAI',
    value: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    modelName: 'gpt-4o',
  },
  {
    label: '豆包 / 火山引擎',
    value: 'doubao',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelName: 'doubao-seed-1.6-thinking-vision-250428',
  },
  {
    label: '通义千问 Qwen-VL',
    value: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelName: 'qwen-vl-max',
  },
]

export const CUSTOM_PROVIDER_VALUE = 'custom'
