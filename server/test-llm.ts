import 'dotenv/config';
import { getLlmControlState } from './src/services/llm-control.service.js';
import { testAllProviders } from './src/services/llm-health.service.js';

async function main() {
  console.log("--- LLM CONTROL STATE ---");
  const state = await getLlmControlState();
  console.log("Providers:", JSON.stringify(state.providers, null, 2));
  console.log("Allowed Models:", JSON.stringify(state.models.allowed, null, 2));
  console.log("API Keys configured:", {
    anthropic: !!state.apiKeys.anthropic,
    deepseek: !!state.apiKeys.deepseek,
    gemini: !!state.apiKeys.gemini,
  });
  
  console.log("\n--- TESTING PROVIDERS ---");
  const results = await testAllProviders();
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
