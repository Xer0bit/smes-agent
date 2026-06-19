#!/usr/bin/env tsx
/**
 * Cleanup Script for Expired Trash
 * Run this periodically (e.g., via cron) to clean up projects that have been in trash for more than 1 hour
 * 
 * Usage:
 *   npx tsx scripts/cleanup-trash.ts
 * 
 * Cron example (run every hour):
 *   0 * * * * cd /path/to/ecomgear && npx tsx scripts/cleanup-trash.ts
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_ROLE_KEY not set');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const STORAGE_BUCKET = 'user-projects-free';
const TRASH_PREFIX = '_trash';
const RECOVERY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

async function cleanupExpiredTrash() {
    console.log('🗑️  Starting trash cleanup...');
    console.log(`📅 Recovery window: ${RECOVERY_WINDOW_MS / 1000 / 60} minutes`);

    try {
        // List all projects in trash
        const { data: trashList, error: listError } = await supabase.storage
            .from(STORAGE_BUCKET)
            .list(TRASH_PREFIX);

        if (listError) throw listError;

        if (!trashList || trashList.length === 0) {
            console.log('✅ No trash to clean');
            return;
        }

        console.log(`📦 Found ${trashList.length} items in trash`);

        let deletedCount = 0;
        let skippedCount = 0;
        const now = Date.now();

        for (const project of trashList) {
            if (project.name === '.emptyFolderPlaceholder') continue;

            const metadataPath = `${TRASH_PREFIX}/${project.name}/.project-meta.json`;

            // Check deletion time
            const { data: metaData, error: metaError } = await supabase.storage
                .from(STORAGE_BUCKET)
                .download(metadataPath);

            if (metaError || !metaData) {
                console.log(`⚠️  No metadata for ${project.name}, skipping`);
                skippedCount++;
                continue;
            }

            const metadata = JSON.parse(await metaData.text());
            if (!metadata.deletedAt) {
                console.log(`⚠️  No deletion time for ${project.name}, skipping`);
                skippedCount++;
                continue;
            }

            const deletedTime = new Date(metadata.deletedAt).getTime();
            const age = now - deletedTime;
            const ageMinutes = Math.floor(age / 1000 / 60);

            if (age > RECOVERY_WINDOW_MS) {
                // Expired - permanently delete
                console.log(`🗑️  Deleting expired project ${project.name} (age: ${ageMinutes} minutes)`);

                // List all files in the project
                const { data: fileList, error: fileListError } = await supabase.storage
                    .from(STORAGE_BUCKET)
                    .list(`${TRASH_PREFIX}/${project.name}`);

                if (fileListError) {
                    console.error(`❌ Failed to list files for ${project.name}:`, fileListError);
                    continue;
                }

                if (fileList && fileList.length > 0) {
                    const filePaths = fileList.map((f) => `${TRASH_PREFIX}/${project.name}/${f.name}`);
                    const { error: deleteError } = await supabase.storage
                        .from(STORAGE_BUCKET)
                        .remove(filePaths);

                    if (deleteError) {
                        console.error(`❌ Failed to delete files for ${project.name}:`, deleteError);
                        continue;
                    }

                    console.log(`   ✓ Deleted ${filePaths.length} files`);
                    deletedCount++;
                }
            } else {
                const remainingMinutes = Math.ceil((RECOVERY_WINDOW_MS - age) / 1000 / 60);
                console.log(`⏳ ${project.name} still recoverable (${remainingMinutes} minutes remaining)`);
                skippedCount++;
            }
        }

        console.log('\n📊 Cleanup Summary:');
        console.log(`   ✅ Deleted: ${deletedCount} projects`);
        console.log(`   ⏳ Skipped: ${skippedCount} projects`);
        console.log(`   📦 Total: ${trashList.length} items`);
    } catch (error) {
        console.error('❌ Cleanup failed:', error);
        process.exit(1);
    }
}

// Run cleanup
cleanupExpiredTrash()
    .then(() => {
        console.log('\n✅ Cleanup complete');
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    });
