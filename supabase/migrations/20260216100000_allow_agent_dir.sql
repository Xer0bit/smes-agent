-- Migration: Allow .agent directory access and expaned MIME types
-- Purpose: Ensure .agent directory files can be read/written and expand allowed MIME types

-- Update bucket configuration to allow more MIME types (e.g. for agent configs, binaries)
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'text/*', 
  'application/json', 
  'image/*', 
  'application/javascript', 
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'text/yaml',
  'application/octet-stream' -- Allow generic binaries
]
WHERE id = 'user-projects-free';

-- Ensure RLS policies explicitly allow .agent directory (already covered by project/* wildcard but reinforcing)
-- No changes needed to RLS if using split_part on projects/{id}/*

-- Example comment to confirm .agent support:
-- The path 'projects/{project_id}/.agent/*' is valid under current policies.
