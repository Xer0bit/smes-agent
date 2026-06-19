import Anthropic from '@anthropic-ai/sdk';

if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not set - AI features will be disabled');
}

export const anthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
    })
    : null;

export const AI_CONFIG = {
    model: process.env.AI_MODEL || 'gemini-2.5-pro',
    maxTokens: parseInt(process.env.AI_MAX_TOKENS || '8192', 10),
    temperature: parseFloat(process.env.AI_TEMPERATURE || '0.7')
};

export default anthropic;
