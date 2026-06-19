/**
 * Types for Publish module - Build and deployment
 */

export interface GeneratedFile {
  path: string;
  content: string;
  type?: string;
}

export interface BundleRequest {
  files: GeneratedFile[];
  entryPoint?: string;
}

export interface BundleResponse {
  success: boolean;
  bundledFiles?: GeneratedFile[];
  error?: string;
}

export interface DeployRequest {
  files: GeneratedFile[];
  userId: string;
  projectId: string;
  revisionNumber: number;
}

export interface DeployResponse {
  success: boolean;
  cdnUrl?: string;
  previewUrl?: string;
  buildId?: string;
  error?: string;
}

export interface BuildParams {
  revisionId: string;
  projectId: string;
  userId: string;
  revisionNumber: number;
  workingFiles: GeneratedFile[];
  dbClient: any;
  storageUrl: string;
  anonKey: string;
}

export interface BuildStatus {
  status: 'pending' | 'building' | 'ready' | 'failed';
  previewUrl?: string;
  cloudflareUrl?: string;
  buildError?: string;
}

// Domain types
export type DomainStatus = 'pending_dns' | 'verifying' | 'active' | 'failed' | 'inactive';

export interface ProjectSubdomain {
  id: string;
  project_id: string;
  subdomain: string;
  full_domain: string;
  is_primary: boolean;
  status: DomainStatus;
  created_at: string;
  updated_at: string;
}

export interface ProjectCustomDomain {
  id: string;
  project_id: string;
  domain: string;
  status: DomainStatus;
  dns_a_record: string | null;
  dns_txt_record: string | null;
  ssl_status: string;
  verified_at?: string;
  created_at: string;
  updated_at: string;
}

export interface DomainConfiguration {
  a_record?: { type: 'A'; host: string; value: string };
  cname_record?: { type: 'CNAME'; host: string; value: string };
  txt_record: { type: 'TXT'; host: string; value: string };
  is_apex: boolean;
}

export interface PublishRequest {
  projectId: string;
  userId: string;
  domain: string;
  domainType: 'subdomain' | 'custom';
}

export interface PublishResponse {
  success: boolean;
  publishedUrl?: string;
  domainStatus?: DomainStatus;
  error?: string;
}
