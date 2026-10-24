const OpenAI = require('openai');
const { Logger } = require('./logger');

const GEMINI_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash-lite',
];
const GEMINI_DEFAULT_MODEL = GEMINI_MODELS[0];
// Floor for the single retry after a thinking model exhausts a small budget.
const GEMINI_THINKING_RETRY_MIN_TOKENS = 1024;

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6',
    models: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6-sol',
    models: ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5', 'google/gemini-3.7-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3'],
    envKey: 'OPENROUTER_API_KEY',
  },
  kimi: {
    name: 'Kimi (Moonshot AI)',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    envKey: 'MOONSHOT_API_KEY',
  },
  mimo: {
    name: 'MiMo (Xiaomi)',
    baseURL: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    envKey: 'MIMO_API_KEY',
  },
  glm: {
    name: 'GLM (Zhipu AI)',
    baseURL: 'https://api.z.ai/api/paas/v4/',
    defaultModel: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.2', 'glm-5.1'],
    envKey: 'GLM_API_KEY',
  },
};

// Asks for audience-facing text in the channel language (a BCP 47 code such as pt-BR).
function withContentLanguage(prompt) {
  const language = process.env.CONTENT_LANGUAGE;
  if (!language || typeof prompt !== 'string') return prompt;
  return `${prompt}\n\nWrite every piece of audience-facing text (titles, scripts, narration, descriptions, tags, captions and replies) in the language with BCP 47 code "${language}". Keep JSON keys, field names and the requested format exactly as specified.`;
}

class AITextService {
  constructor(credentials = {}) {
    this.logger = new Logger('AITextService');
    this.client = null;
    this.gemini = null;
    this.model = null;
    this.providerName = null;

    this._init(credentials);
  }

  _init(credentials) {
    const provider = credentials.aiProvider?.provider;
    const apiKey = credentials.aiProvider?.apiKey;
    const model = credentials.aiProvider?.model;

    if (provider && PROVIDERS[provider] && apiKey) {
      return this._initOpenAICompatible(PROVIDERS[provider], apiKey, model);
    }

    for (const [, preset] of Object.entries(PROVIDERS)) {
      const key = process.env[preset.envKey];
      if (key) {
        return this._initOpenAICompatible(preset, key);
      }
    }

    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      return this._initGemini(geminiKey, credentials.gemini?.model);
    }

    this.logger.warn('No AI text provider configured — text generation unavailable');
  }

  _initOpenAICompatible(preset, apiKey, model) {
    this.client = new OpenAI({ apiKey, baseURL: preset.baseURL });
    this.model = model || preset.defaultModel;
    this.providerName = preset.name;
    this.logger.info(`${preset.name} initialized (model: ${this.model})`);
  }

  _initGemini(apiKey, model) {
    try {
      const { GoogleGenAI } = require('@google/genai');
      this.gemini = new GoogleGenAI({ apiKey });
      this.model = model || GEMINI_DEFAULT_MODEL;
      this.providerName = 'Google Gemini';
      this.logger.info(`Gemini initialized (model: ${this.model})`);
    } catch (error) {
      this.logger.error('Failed to initialize Gemini:', error.message);
    }
  }

  // Overloaded models (503 "high demand") recover within seconds, so retry them
  // with backoff; callers otherwise fall back to a generic English template.
  // Quota errors (429) are not retried: they last hours.
  async generateText(prompt, options = {}) {
    prompt = withContentLanguage(prompt);
    const baseDelay = Number(process.env.GENERATION_RETRY_BASE_MS) || 1000;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._generateTextOnce(prompt, options);
      } catch (error) {
        const overloaded = [500, 502, 503, 504].includes(Number(error?.status)) ||
          /"code":\s*50[0234]|UNAVAILABLE|high demand|overloaded/i.test(error?.message || '');
        if (!overloaded || attempt >= 3) throw error;
        const delay = baseDelay * 2 ** (attempt + 1);
        this.logger.warn(`${this.providerName} is overloaded; retrying in ${delay}ms (attempt ${attempt + 2} of 4)`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async _generateTextOnce(prompt, options = {}) {
    const model = options.model || this.model;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;

    if (this.gemini) {
      const config = { maxOutputTokens: maxTokens };
      if (!/^gemini-3\.(?:[5-9]|\d{2,})-/.test(model)) config.temperature = temperature;
      let response = await this.gemini.models.generateContent({
        model,
        contents: prompt,
        config,
      });
      let text = response && response.text;

      // Thinking models (gemini-3.x flash/pro) count thoughts against
      // maxOutputTokens, so a small budget can be spent before any text is
      // written, or cut the answer (often JSON) short. Retry once with room
      // for the thoughts plus the answer.
      if (this._geminiFinishReason(response) === 'MAX_TOKENS') {
        const retryTokens = Math.max(maxTokens * 4, GEMINI_THINKING_RETRY_MIN_TOKENS);
        response = await this.gemini.models.generateContent({
          model,
          contents: prompt,
          config: { ...config, maxOutputTokens: retryTokens },
        });
        text = response && response.text;
      }

      if (!this._hasText(text)) {
        throw new Error(this._geminiEmptyResponseMessage(response));
      }
      return text;
    }

    if (!this.client) {
      throw new Error('No AI text provider configured');
    }

    const params = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
    };

    const tokenParams = [
      { max_completion_tokens: maxTokens },
      { max_tokens: maxTokens },
    ];

    let lastError = null;
    for (let index = 0; index < tokenParams.length; index++) {
      const request = { ...params, ...tokenParams[index] };
      try {
        const response = await this.client.chat.completions.create(request);
        return this._extractContent(response);
      } catch (error) {
        lastError = error;
        const message = error?.message || '';
        const unsupportedTemperature =
          error?.status === 400 &&
          /temperature/i.test(message) &&
          /(unsupported value|does not support|only the default)/i.test(message);

        if (unsupportedTemperature) {
          const { temperature: _temperature, ...withoutTemperature } = request;
          try {
            const response = await this.client.chat.completions.create(withoutTemperature);
            return this._extractContent(response);
          } catch (retryError) {
            lastError = retryError;
          }
        }

        // Older models and some providers reject max_completion_tokens with a
        // 400; retry with the legacy max_tokens spelling. This also applies if
        // the temperature-compatible retry exposed the token incompatibility.
        if (
          index === 0 &&
          lastError?.status === 400 &&
          /max(_completion)?_tokens/i.test(lastError.message || '')
        ) {
          continue;
        }
        throw lastError;
      }
    }

    throw lastError;
  }

  _hasText(text) {
    return typeof text === 'string' && text.trim().length > 0;
  }

  _geminiFinishReason(response) {
    return response?.candidates?.[0]?.finishReason || null;
  }

  _geminiEmptyResponseMessage(response) {
    const finishReason = this._geminiFinishReason(response);
    const blockReason = response?.promptFeedback?.blockReason;
    if (finishReason === 'MAX_TOKENS') {
      const thoughts = response?.usageMetadata?.thoughtsTokenCount;
      return `${this.providerName} spent its whole output budget${thoughts ? ` (${thoughts} thinking tokens)` : ''} before writing any text. Raise maxTokens, or choose a model that does not think, such as gemini-3.5-flash-lite.`;
    }
    if (blockReason || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'].includes(finishReason)) {
      return `${this.providerName} blocked the response (${blockReason || finishReason}). Rephrase the prompt or topic and try again.`;
    }
    return `${this.providerName} returned an empty response${finishReason ? ` (finishReason: ${finishReason})` : ''}. Check the API key and model quota — free-tier Gemini keys are rate-limited and can return empty output.`;
  }

  _extractContent(response) {
    const content =
      response &&
      response.choices &&
      response.choices[0] &&
      response.choices[0].message
        ? response.choices[0].message.content
        : null;

    if (typeof content !== 'string' || !content.trim()) {
      // A null/empty body used to surface as cryptic "Unexpected end of JSON input"
      // in the agents' JSON parsers. Report the real cause instead.
      throw new Error(
        `${this.providerName} returned an empty response. Check the API key and model quota.`
      );
    }
    return content;
  }

  isAvailable() {
    return !!(this.client || this.gemini);
  }
}

module.exports = { AITextService, PROVIDERS, GEMINI_MODELS, GEMINI_DEFAULT_MODEL };
