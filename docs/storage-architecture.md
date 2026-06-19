# Storage-Only File System Architecture

## Overview
Files are stored **ONLY** in Supabase Storage (`user-projects-free` bucket). The database JSONB field is used temporarily during file transfer, then immediately cleaned up.

## File Flow

```
AI Generates Code
       ↓
Save to DB (temporary JSONB)
       ↓
Upload to Storage Bucket ✅ (permanent)
       ↓
Clean up JSONB (set to null)
       ↓
Storage is single source of truth
```

## Storage Structure

```
user-projects-free/
├── {projectId}/
│   ├── .project-meta.json          # Project metadata
│   └── {revisionId}/               # Revision files
│       ├── index.html
│       ├── App.tsx
│       ├── styles.css
│       └── ...
└── _trash/                         # Soft-deleted projects
    └── {projectId}/
        └── {revisionId}/
            └── files...
```

## Database Schema

### revisions table
```sql
- id: UUID
- project_id: UUID
- prompt: TEXT
- generated_code: TEXT (legacy, kept for compatibility)
- generated_files: JSONB (temporary, cleaned after upload)
- file_count: INTEGER (reference count)
- preview_url: TEXT (signed URL from storage)
- created_at: TIMESTAMP
```

**Key Points:**
- `generated_files` is NULL after upload completes
- `file_count` stores number of files for reference
- Files are loaded from storage, never from database

## API Methods

### Save Files
```typescript
// Creates revision, uploads to storage, cleans JSONB
await revisionService.createRevision({
  project_id,
  prompt,
  generated_code,
  generated_files: { files: [...] }, // Temporary
  user_id
});

// Flow:
// 1. Insert to DB with JSONB
// 2. Upload files to storage
// 3. Set generated_files = null
// 4. Set file_count = files.length
```

### Load Files
```typescript
// Loads ONLY from storage
const files = await revisionService.getRevisionFiles(projectId, revisionId);

// Returns: GeneratedFile[]
// Source: user-projects-free/{projectId}/{revisionId}/*
```

### Delete Files
```typescript
// Soft delete (1-hour recovery)
await revisionService.deleteProject(projectId, userId);
// Moves to: _trash/{projectId}/

// Recover (within 1 hour)
await revisionService.recoverProject(projectId, userId);

// Permanent delete
await revisionService.permanentlyDeleteProject(projectId, userId);
```

## Preview System

### Signed URLs
```typescript
// Get preview URL for index.html
const url = await storageService.getSignedUrl(
  projectId,
  revisionId,
  'index.html',
  3600 // 1 hour expiry
);

// Get all file URLs
const urls = await storageService.getRevisionSignedUrls(
  projectId,
  revisionId
);
// Returns: { 'index.html': 'https://...', 'App.tsx': 'https://...', ... }
```

### Preview Flow
```
1. Load files from storage
2. Generate signed URLs (1 hour)
3. Display in iframe
4. URLs auto-expire for security
```

## Benefits

### ✅ Advantages
1. **Scalability** - Storage designed for files, not database
2. **Performance** - Faster file access, no JSONB parsing
3. **Cost** - Storage cheaper than database for large files
4. **Clean** - Database stays lean, only metadata
5. **Security** - Private bucket with signed URLs
6. **Recovery** - Soft-delete with trash system

### 🔄 Migration Path
For existing projects with files in JSONB:
```typescript
// One-time migration script
async function migrateToStorage() {
  const revisions = await getRevisionsWithJSONB();
  
  for (const rev of revisions) {
    if (rev.generated_files?.files) {
      // Upload to storage
      await storageService.saveProjectFiles(
        rev.project_id,
        rev.id,
        rev.generated_files.files
      );
      
      // Clean JSONB
      await supabase
        .from('revisions')
        .update({ 
          generated_files: null,
          file_count: rev.generated_files.files.length
        })
        .eq('id', rev.id);
    }
  }
}
```

## Cleanup

### Automatic Cleanup
```bash
# Run hourly via cron
0 * * * * npx tsx scripts/cleanup-trash.ts
```

### Manual Cleanup
```typescript
// Clean up expired trash
await projectLifecycleService.cleanupExpiredTrash();
```

## Monitoring

### Check Storage Usage
```sql
-- Get total storage per project
SELECT 
  project_id,
  COUNT(*) as revision_count,
  SUM(file_count) as total_files
FROM revisions
GROUP BY project_id;
```

### Verify JSONB Cleanup
```sql
-- Should return 0 rows (all cleaned)
SELECT id, project_id, file_count
FROM revisions
WHERE generated_files IS NOT NULL
  AND file_count > 0;
```

## Best Practices

1. **Always use storage** - Never store file content in database
2. **Clean JSONB immediately** - After upload succeeds
3. **Use signed URLs** - For preview and sharing
4. **Implement soft-delete** - For user recovery
5. **Run cleanup regularly** - Keep trash folder clean
6. **Monitor storage** - Track usage and costs

## Troubleshooting

### Files not appearing?
```typescript
// Check storage
const files = await storageService.loadProjectFiles(projectId, revisionId);
console.log('Files in storage:', files);

// Check JSONB (should be null)
const { data } = await supabase
  .from('revisions')
  .select('generated_files, file_count')
  .eq('id', revisionId)
  .single();
console.log('JSONB:', data.generated_files); // Should be null
console.log('File count:', data.file_count);
```

### Preview not working?
```typescript
// Generate fresh signed URL
const url = await storageService.getSignedUrl(
  projectId,
  revisionId,
  'index.html'
);
console.log('Preview URL:', url);
```
