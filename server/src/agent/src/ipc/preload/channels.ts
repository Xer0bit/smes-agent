/**
 * Channel Definitions for Preload Script
 *
 * This file derives the list of valid IPC channels from contract definitions.
 * It serves as the single source of truth for the preload script's channel whitelist.
 *
 * All channels are now derived from contracts - no legacy channels remain.
 */

import {
  getInvokeChannels,
  getReceiveChannels,
  getStreamChannels,
} from "../contracts/core.js";

// Import all contracts
import { settingsContracts } from "../types/settings.js";
import { appContracts } from "../types/app.js";
import { chatContracts, chatStreamContract } from "../types/chat.js";
import { agentContracts, agentEvents } from "../types/agent.js";
import { githubContracts, gitContracts, githubEvents } from "../types/github.js";
import { mcpContracts, mcpEvents } from "../types/mcp.js";
import { vercelContracts } from "../types/vercel.js";
import { supabaseContracts } from "../types/supabase.js";
import { neonContracts } from "../types/neon.js";
import { systemContracts, systemEvents } from "../types/system.js";
import { versionContracts } from "../types/version.js";
import { languageModelContracts } from "../types/language-model.js";
import { promptContracts } from "../types/prompts.js";
import { templateContracts } from "../types/templates.js";
import { proposalContracts } from "../types/proposals.js";
import { importContracts } from "../types/import.js";
import { helpContracts, helpStreamContract } from "../types/help.js";
import { capacitorContracts } from "../types/capacitor.js";
import { contextContracts } from "../types/context.js";
import { upgradeContracts } from "../types/upgrade.js";
import { visualEditingContracts } from "../types/visual-editing.js";
import { securityContracts } from "../types/security.js";
import { miscContracts, miscEvents } from "../types/misc.js";
import { freeAgentQuotaContracts } from "../types/free_agent_quota.js";
import { planEvents, planContracts } from "../types/plan.js";
import { audioContracts } from "../types/audio.js";
import { mediaContracts } from "../types/media.js";
import { imageGenerationContracts } from "../types/image_generation.js";

// =============================================================================
// Invoke Channels (derived from all contracts)
// =============================================================================

const CHAT_STREAM_CHANNELS = getStreamChannels(chatStreamContract);
const HELP_STREAM_CHANNELS = getStreamChannels(helpStreamContract);

// Test-only channels (handler only registered in E2E test builds, but channel always allowed)
const TEST_INVOKE_CHANNELS = [
  "test:simulateQuotaTimeElapsed",
  "test:set-node-mock",
] as const;

/**
 * All valid invoke channels derived from contracts.
 * Used by preload.ts to whitelist IPC channels.
 */
export const VALID_INVOKE_CHANNELS = [
  // Core domains
  ...getInvokeChannels(settingsContracts),
  ...getInvokeChannels(appContracts),
  ...getInvokeChannels(chatContracts),
  ...getInvokeChannels(agentContracts),

  // Stream invoke channels
  CHAT_STREAM_CHANNELS.invoke,
  HELP_STREAM_CHANNELS.invoke,

  // Integrations
  ...getInvokeChannels(githubContracts),
  ...getInvokeChannels(gitContracts),
  ...getInvokeChannels(mcpContracts),
  ...getInvokeChannels(vercelContracts),
  ...getInvokeChannels(supabaseContracts),
  ...getInvokeChannels(neonContracts),

  // Features
  ...getInvokeChannels(systemContracts),
  ...getInvokeChannels(versionContracts),
  ...getInvokeChannels(languageModelContracts),
  ...getInvokeChannels(promptContracts),
  ...getInvokeChannels(templateContracts),
  ...getInvokeChannels(proposalContracts),
  ...getInvokeChannels(importContracts),
  ...getInvokeChannels(helpContracts),
  ...getInvokeChannels(capacitorContracts),
  ...getInvokeChannels(contextContracts),
  ...getInvokeChannels(upgradeContracts),
  ...getInvokeChannels(visualEditingContracts),
  ...getInvokeChannels(securityContracts),
  ...getInvokeChannels(miscContracts),
  ...getInvokeChannels(freeAgentQuotaContracts),
  ...getInvokeChannels(planContracts),
  ...getInvokeChannels(audioContracts),
  ...getInvokeChannels(mediaContracts),
  ...getInvokeChannels(imageGenerationContracts),

  // Test-only channels
  ...TEST_INVOKE_CHANNELS,
] as const;

// =============================================================================
// Receive Channels (derived from all event contracts + stream events)
// =============================================================================

/**
 * All valid receive channels derived from contracts.
 * Used by preload.ts to whitelist IPC channels.
 */
export const VALID_RECEIVE_CHANNELS = [
  // Stream receive channels
  ...CHAT_STREAM_CHANNELS.receive,
  ...HELP_STREAM_CHANNELS.receive,

  // Event channels
  ...getReceiveChannels(agentEvents),
  ...getReceiveChannels(githubEvents),
  ...getReceiveChannels(mcpEvents),
  ...getReceiveChannels(systemEvents),
  ...getReceiveChannels(miscEvents),
  ...getReceiveChannels(planEvents),
] as const;

// =============================================================================
// Type Exports
// =============================================================================

export type ValidInvokeChannel = (typeof VALID_INVOKE_CHANNELS)[number];
export type ValidReceiveChannel = (typeof VALID_RECEIVE_CHANNELS)[number];
