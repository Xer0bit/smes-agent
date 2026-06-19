/**
 * Type-Safe IPC Layer
 *
 * This module provides a unified, type-safe interface for all IPC operations.
 * Contracts define the single source of truth for channel names, input schemas,
 * and output schemas. Clients are auto-generated from contracts.
 *
 * @example
 * // Invoke-response pattern
 * const settings = await ipc.settings.getUserSettings();
 * const { app, chatId } = await ipc.app.createApp({ name: "my-app" });
 *
 * // Streaming pattern
 * ipc.chatStream.start(
 *   { chatId: 123, prompt: "Hello" },
 *   { onChunk, onEnd, onError }
 * );
 *
 * // Event subscription pattern
 * const unsubscribe = ipc.events.agent.onTodosUpdate((payload) => {
 *   updateTodoList(payload.todos);
 * });
 */

// =============================================================================
// Contract Exports
// =============================================================================

export { settingsContracts } from "./settings.js";
export { appContracts } from "./app.js";
export { chatContracts, chatStreamContract } from "./chat.js";
export { agentContracts, agentEvents } from "./agent.js";
export { githubContracts, gitContracts, githubEvents } from "./github.js";
export { mcpContracts, mcpEvents } from "./mcp.js";
export { vercelContracts } from "./vercel.js";
export { supabaseContracts } from "./supabase.js";
export { neonContracts } from "./neon.js";
export { systemContracts, systemEvents } from "./system.js";
export { versionContracts } from "./version.js";
export { languageModelContracts } from "./language-model.js";
export { promptContracts } from "./prompts.js";
export { templateContracts } from "./templates.js";
export { proposalContracts } from "./proposals.js";
export { importContracts } from "./import.js";
export { helpContracts, helpStreamContract } from "./help.js";
export { capacitorContracts } from "./capacitor.js";
export { contextContracts } from "./context.js";
export { upgradeContracts } from "./upgrade.js";
export { visualEditingContracts } from "./visual-editing.js";
export { securityContracts } from "./security.js";
export { miscContracts, miscEvents } from "./misc.js";
export { freeAgentQuotaContracts } from "./free_agent_quota.js";
export { audioContracts } from "./audio.js";
export { mediaContracts } from "./media.js";
export { imageGenerationContracts } from "./image_generation.js";

// =============================================================================
// Client Exports
// =============================================================================

export { settingsClient } from "./settings.js";
export { appClient } from "./app.js";
export { chatClient, chatStreamClient } from "./chat.js";
export { agentClient, agentEventClient } from "./agent.js";
export { githubClient, gitClient, githubEventClient } from "./github.js";
export { mcpClient, mcpEventClient } from "./mcp.js";
export { vercelClient } from "./vercel.js";
export { supabaseClient } from "./supabase.js";
export { neonClient } from "./neon.js";
export { systemClient, systemEventClient } from "./system.js";
export { versionClient } from "./version.js";
export { languageModelClient } from "./language-model.js";
export { promptClient } from "./prompts.js";
export { templateClient } from "./templates.js";
export { proposalClient } from "./proposals.js";
export { importClient } from "./import.js";
export { helpClient, helpStreamClient } from "./help.js";
export { capacitorClient } from "./capacitor.js";
export { contextClient } from "./context.js";
export { upgradeClient } from "./upgrade.js";
export { visualEditingClient } from "./visual-editing.js";
export { securityClient } from "./security.js";
export { miscClient, miscEventClient } from "./misc.js";
export { freeAgentQuotaClient } from "./free_agent_quota.js";
export { audioClient } from "./audio.js";
export { mediaClient } from "./media.js";
export { imageGenerationClient } from "./image_generation.js";

// =============================================================================
// Type Exports
// =============================================================================

// Settings types
export type {
  GetUserSettingsInput,
  GetUserSettingsOutput,
  SetUserSettingsInput,
  SetUserSettingsOutput,
} from "./settings.js";

// App types
export type {
  App,
  CreateAppParams,
  CreateAppResult,
  CopyAppParams,
  EditAppFileReturnType,
  RespondToAppInputParams,
  AppFileSearchResult,
  ChangeAppLocationParams,
  ChangeAppLocationResult,
  ListAppsResponse,
  RenameBranchParams,
  UpdateAppCommandsParams,
} from "./app.js";

// Chat types
export type {
  Message,
  Chat,
  ComponentSelection,
  FileAttachment,
  ChatAttachment,
  ChatStreamParams,
  ChatResponseEnd,
  UpdateChatParams,
  TokenCountParams,
  TokenCountResult,
} from "./chat.js";

// Agent types
export type {
  AgentTool,
  AgentTodo,
  AgentToolConsentRequestPayload,
  AgentToolConsentDecision,
  AgentToolConsentResponseParams,
  AgentTodosUpdatePayload,
  AgentProblemsUpdatePayload,
  SetAgentToolConsentParams,
  Problem,
  ProblemReport,
} from "./agent.js";

// GitHub types
export type {
  GitBranchAppIdParams,
  GitBranchParams,
  CreateGitBranchParams,
  RenameGitBranchParams,
  ListRemoteGitBranchesParams,
  CommitChangesParams,
  UncommittedFile,
  UncommittedFileStatus,
  GithubSyncOptions,
  CloneRepoParams,
  GithubRepository,
} from "./github.js";

// MCP types
export type {
  McpServer,
  McpTransport,
  CreateMcpServer,
  McpServerUpdate,
  McpTool,
  McpToolConsent,
  McpConsentValue,
  McpConsentDecision,
  SetMcpToolConsentParams,
  McpConsentRequestPayload,
  McpConsentResponseParams,
} from "./mcp.js";

// Vercel types
export type {
  VercelProject,
  VercelDeployment,
  SaveVercelAccessTokenParams,
  ConnectToExistingVercelProjectParams,
  IsVercelProjectAvailableParams,
  IsVercelProjectAvailableResponse,
  CreateVercelProjectParams,
  GetVercelDeploymentsParams,
  DisconnectVercelProjectParams,
} from "./vercel.js";

// Supabase types
export type {
  SupabaseOrganizationInfo,
  SupabaseProject,
  SupabaseBranch,
  DeleteSupabaseOrganizationParams,
  SetSupabaseAppProjectParams,
  ConsoleEntry,
} from "./supabase.js";

// Neon types
export type {
  NeonProject,
  NeonBranch,
  CreateNeonProjectParams,
  GetNeonProjectParams,
  GetNeonProjectResponse,
} from "./neon.js";

// System types
export type {
  NodeSystemInfo,
  SystemDebugInfo,
  SelectNodeFolderResult,
  DoesReleaseNoteExistParams,
  UserBudgetInfo,
  TelemetryEventPayload,
} from "./system.js";

// Version types
export type {
  Version,
  BranchResult,
  RevertVersionParams,
  RevertVersionResponse,
} from "./version.js";

// Language model types
export type {
  LanguageModelProvider,
  LanguageModel,
  LocalModel,
  CreateCustomLanguageModelProviderParams,
  CreateCustomLanguageModelParams,
} from "./language-model.js";

// Prompt types
export type {
  PromptDto,
  CreatePromptParamsDto,
  UpdatePromptParamsDto,
} from "./prompts.js";

// Template types
export type {
  Template,
  Theme,
  SetAppThemeParams,
  GetAppThemeParams,
  CustomTheme,
  CreateCustomThemeParams,
  UpdateCustomThemeParams,
  DeleteCustomThemeParams,
  ThemeGenerationMode,
  ThemeGenerationModel,
  ThemeGenerationModelOption,
  ThemeInputSource,
  CrawlStatus,
  GenerateThemePromptParams,
  GenerateThemePromptResult,
  GenerateThemeFromUrlParams,
  SaveThemeImageParams,
  SaveThemeImageResult,
  CleanupThemeImagesParams,
} from "./templates.js";

// Proposal types
export type { ProposalResult, ApproveProposalResult } from "./proposals.js";

// Import types
export type { ImportAppParams, ImportAppResult } from "./import.js";

// Help types
export type { HelpChatStartParams } from "./help.js";

// Context types
export type { ContextPathResults, AppChatContext } from "./context.js";

// Upgrade types
export type { AppUpgrade } from "./upgrade.js";

// Visual editing types
export type {
  VisualEditingChange,
  ApplyVisualEditingChangesParams,
  AnalyseComponentParams,
} from "./visual-editing.js";

// Security types
export type { SecurityReviewResult } from "./security.js";

// Misc types
export type {
  SessionDebugBundle,
  DeepLinkData,
  AppOutput,
  EnvVar,
} from "./misc.js";

// Free agent quota types
export type { FreeAgentQuotaStatus } from "./free_agent_quota.js";

// Pro types
export type { TranscribeAudioParams, TranscribeAudioResult } from "./audio.js";

// Media types
export type {
  MediaFile,
  RenameMediaFileParams,
  DeleteMediaFileParams,
  MoveMediaFileParams,
} from "./media.js";

// Image generation types
export type {
  ImageThemeMode,
  GenerateImageParams,
  GenerateImageResponse,
} from "./image_generation.js";

// =============================================================================
// Schema Exports (for validation in handlers/components)
// =============================================================================

export {
  AppSchema,
  CreateAppParamsSchema,
  CreateAppResultSchema,
  AppFileSearchResultSchema,
} from "./app.js";

export {
  MessageSchema,
  ChatSchema,
  ChatAttachmentSchema,
  ChatStreamParamsSchema,
  ChatResponseEndSchema,
} from "./chat.js";

export {
  AgentTodoSchema,
  AgentTodosUpdateSchema,
  AgentToolSchema,
  AgentToolConsentRequestSchema,
} from "./agent.js";

export { UserBudgetInfoSchema } from "./system.js";

// =============================================================================
// Aggregated IPC Client
// =============================================================================

import { settingsClient } from "./settings.js";
import { appClient } from "./app.js";
import { chatClient, chatStreamClient } from "./chat.js";
import { agentClient, agentEventClient } from "./agent.js";
import { githubClient, gitClient, githubEventClient } from "./github.js";
import { mcpClient, mcpEventClient } from "./mcp.js";
import { vercelClient } from "./vercel.js";
import { supabaseClient } from "./supabase.js";
import { neonClient } from "./neon.js";
import { systemClient, systemEventClient } from "./system.js";
import { versionClient } from "./version.js";
import { languageModelClient } from "./language-model.js";
import { promptClient } from "./prompts.js";
import { templateClient } from "./templates.js";
import { proposalClient } from "./proposals.js";
import { importClient } from "./import.js";
import { helpClient, helpStreamClient } from "./help.js";
import { capacitorClient } from "./capacitor.js";
import { contextClient } from "./context.js";
import { upgradeClient } from "./upgrade.js";
import { visualEditingClient } from "./visual-editing.js";
import { securityClient } from "./security.js";
import { miscClient, miscEventClient } from "./misc.js";
import { freeAgentQuotaClient } from "./free_agent_quota.js";
import { audioClient } from "./audio.js";
import { mediaClient } from "./media.js";
import { imageGenerationClient } from "./image_generation.js";

/**
 * Unified IPC client with all domains organized by namespace.
 *
 * @example
 * // Settings
 * const settings = await ipc.settings.getUserSettings();
 *
 * // App management
 * const app = await ipc.app.getApp(appId);
 *
 * // Chat operations
 * const chat = await ipc.chat.getChat(chatId);
 *
 * // Streaming
 * ipc.chatStream.start(params, callbacks);
 *
 * // Event subscriptions
 * ipc.events.agent.onTodosUpdate(handler);
 */
export const ipc = {
  // Core domains
  settings: settingsClient,
  app: appClient,
  chat: chatClient,
  agent: agentClient,

  // Streaming clients
  chatStream: chatStreamClient,
  helpStream: helpStreamClient,

  // Integrations
  github: githubClient,
  git: gitClient,
  mcp: mcpClient,
  vercel: vercelClient,
  supabase: supabaseClient,
  neon: neonClient,

  // Features
  system: systemClient,
  version: versionClient,
  languageModel: languageModelClient,
  prompt: promptClient,
  template: templateClient,
  proposal: proposalClient,
  import: importClient,
  help: helpClient,
  capacitor: capacitorClient,
  context: contextClient,
  upgrade: upgradeClient,
  visualEditing: visualEditingClient,
  security: securityClient,
  misc: miscClient,
  freeAgentQuota: freeAgentQuotaClient,
  audio: audioClient,
  media: mediaClient,
  imageGeneration: imageGenerationClient,

  // Event clients for main->renderer pub/sub
  events: {
    agent: agentEventClient,
    github: githubEventClient,
    mcp: mcpEventClient,
    system: systemEventClient,
    misc: miscEventClient,
  },
} as const;
