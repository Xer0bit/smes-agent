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

export interface PromptHandlerParams {
  promptText: string;
  projectId: string;
  userId: string;
  currentUser: any;
  organizationId?: string | null;
  fileContext?: string;
  existingFiles: GeneratedFile[];
  hasRealApp: boolean;
  /** Guest fingerprint — when set, the user is not authenticated */
  fingerprint?: string;
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
  /** True when the agent ran in build mode but wrote zero files — ghost run */
  ghostRun?: boolean;
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
