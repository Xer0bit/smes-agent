import {
  getAppBuilderBuildSystemPrompt,
  getAppBuilderSystemPrompt,
  MICRO_SYSTEM_PROMPT,
  getFixSystemPrompt,
  getEditSystemPrompt,
} from '../prompts/app-builder.prompt.js';

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PromptBuilderOptions {
  providerName: string;
  requestTier?: string;
  projectContext?: Record<string, string>;
  isFixing?: boolean;
  isEdit?: boolean;
}

/**
 * Builds system prompt messages tailored to model provider and request execution tier.
 */
export function buildSystemMessagesFor(options: PromptBuilderOptions): PromptMessage[] {
  const { providerName, requestTier = 'standard', projectContext = {}, isFixing = false, isEdit = false } = options;

  let basePrompt = '';

  if (isFixing) {
    basePrompt = getFixSystemPrompt();
  } else if (isEdit) {
    basePrompt = getEditSystemPrompt();
  } else if (requestTier === 'fast' || requestTier === 'micro') {
    basePrompt = MICRO_SYSTEM_PROMPT;
  } else if (requestTier === 'enterprise' || requestTier === 'build') {
    basePrompt = getAppBuilderBuildSystemPrompt();
  } else {
    basePrompt = getAppBuilderSystemPrompt('standard');
  }

  // Inject Provider-Specific Nuances & Guardrails
  const providerRules: string[] = [];

  if (providerName.includes('anthropic') || providerName.includes('claude')) {
    providerRules.push(
      'ANT-01: Respond directly with concise tool calls or analysis.',
      'ANT-02: Ensure strict XML tag balance if using XML format snippets.'
    );
  } else if (providerName.includes('gemini')) {
    providerRules.push(
      'GEM-01: Avoid redundant file reads when files are already in context.',
      'GEM-02: Strictly adhere to typed tool arguments schema.'
    );
  } else if (providerName.includes('deepseek')) {
    providerRules.push(
      'DS-01: Focus on immediate syntactic correctness and valid TS imports.'
    );
  }

  // Inject Project Context Attributes if present
  let contextInjection = '';
  if (Object.keys(projectContext).length > 0) {
    contextInjection = `\n\n### ACTIVE WORKSPACE CONTEXT:\n${JSON.stringify(projectContext, null, 2)}`;
  }

  const fullContent = `${basePrompt}\n\n### PROVIDER OPTIMIZATIONS (${providerName.toUpperCase()}):\n${providerRules.join('\n')}${contextInjection}`;

  return [
    {
      role: 'system',
      content: fullContent,
    },
  ];
}
