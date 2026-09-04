/**
 * Types for User Prompt handling module
 */

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
  type?: string;
  operation?: 'create' | 'update' | 'delete';
}

export interface GenerationStageResult {
  files: GeneratedFile[];
  usage?: any;
  summary?: string;
}

/** Uploaded chat attachment metadata forwarded to the agent loop (see chatAttachmentService). */
export interface AgentAttachment {
  name: string;
  type: string;
  category: 'image' | 'document';
  tempPath: string;
  /** Durable fallback if tempPath's /tmp copy has expired (1hr TTL). */
  publicUrl?: string;
}

export interface PromptHandlerParams {
  promptText: string;
  projectId: string;
  userId: string;
  currentUser: any;
  organizationId?: string | null;
  fileContext?: string;
  /** Files uploaded with this prompt   images get vision + place_asset server-side. */
  attachments?: AgentAttachment[];
  existingFiles: GeneratedFile[];
  hasRealApp: boolean;
  /** Guest fingerprint   when set, the user is not authenticated */
  fingerprint?: string;
  /** Internal: auto-continuation recursion depth. Never set this from a caller. */
  _autoContinueDepth?: number;
}

export interface PromptHandlerCallbacks {
  onMessageAdd: (message: Message) => void;
  onSystemMessage: (content: string) => Promise<void>;
  onFilesUpdate: (files: GeneratedFile[]) => void;
  onCodeUpdate: (code: string) => void;
  onLoadingChange: (loading: boolean) => void;
  onWorkflowComplete: (complete: boolean) => void;
  onPreviewStatusChange: (status: 'pending' | 'building' | 'ready' | 'failed') => void;
  onPreviewUrlChange: (url: string) => void;
}

export interface FileRename {
  from: string;
  to: string;
}

export interface GenerationResponse {
  /**
   * Row id the SERVER already wrote for this run's answer. Save with it so the
   * client's own save upserts that row instead of inserting a second one --
   * without it, both sides wrote and one run produced two messages.
   */
  assistantMessageId?: string | null;
  /** Files to write / create / update */
  files: GeneratedFile[];
  /** Runtime mode selected by backend for this generation */
  mode?: 'build' | 'plan';
  /** Aliases for the files array returned by new tag-based backend */
  filesToWrite?: GeneratedFile[];
  /** Paths of files the agent wants to delete */
  filesToDelete?: string[];
  /** Rename operations the agent wants to apply */
  renames?: FileRename[];
  /** npm package names the agent wants to install */
  dependencies?: string[];
  /** Short human-readable summary from <ecomgear-chat-summary> */
  summary?: string;
  usage?: any;
  /** Total tokens consumed by this generation (from server usage telemetry) */
  tokensUsed?: number;
  /** Snapshot ID for rolling back this generation if needed */
  snapshotId?: string;
  /** True when the agent server already pushed files to the preview service */
  previewPushed?: boolean;
  /** True when the agent ran in build mode but wrote zero files   ghost run */
  ghostRun?: boolean;
  /** Schema-changing SQL this run staged for the owner to run, in staging order. */
  stagedSql?: Array<{ id: string; sql_text: string; status: string; created_at: string; error_message: string | null }>;
  /** agent_runs id; the batch key for stagedSql. */
  batchId?: string | null;
  /** True when a browser smoke check found the rendered page broken after this
   *  run and repair couldn't confirm a fix, but the files were kept (not
   *  reverted). Frontend should not show an unqualified success toast. */
  smokeFailureSurvivedRepair?: boolean;
  /** True when every change this run made was reverted to the pre-agent state
   *  (repair gave up and restored the last known-good version). Frontend must
   *  not show an "App updated." success toast for a run whose changes were
   *  all discarded. */
  revertedToPreAgent?: boolean;
  /** The preview could not install a package from package.json; the app may not resolve it. */
  previewDepsError?: string | null;
  /** Actual USD cost of this run (0 on ghost/timeout runs) */
  costUsd?: number;
  /** Eco credits charged for this run (cost-based, clamped 0.5-2.0) */
  ecoUsed?: number;
  /** True when the run hit the budget cap mid-task but made real progress   safe to auto-continue */
  needsAutoContinue?: boolean;
  /** Ready-to-send prompt for the auto-continuation turn, set only when needsAutoContinue is true */
  continuationPrompt?: string;
}

export interface FileNormalizationResult {
  files: GeneratedFile[];
  changes: string[];
}

export interface SyntaxValidationResult {
  valid: boolean;
  errors: Array<{
    file: string;
    line?: number;
    message: string;
  }>;
  fixed: boolean;
}
