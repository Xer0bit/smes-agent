/**
 * Helper functions for usage tracking operations
 */

/**
 * Count total lines of code in generated files (legacy, not used for billing)
 */
export const countLinesInFiles = (files: Array<{ content: string }>): number => {
  return files.reduce((total, file) => {
    const lines = file.content.split('\n').length;
    return total + lines;
  }, 0);
};

/**
 * Format usage display text
 */
export const formatUsageDisplay = (used: number, limit: number, bonus: number = 0): string => {
  if (limit === -1) return `${used} eco used (Unlimited)`;
  const total = limit + bonus;
  return `${used} / ${total} eco`;
};

/**
 * Get color class based on usage percentage
 */
export const getUsageColor = (percentage: number): string => {
  if (percentage >= 100) return 'text-destructive';
  if (percentage >= 80) return 'text-yellow-600';
  return 'text-primary';
};

/**
 * Get progress bar color class based on usage percentage
 */
export const getProgressColor = (percentage: number): string => {
  if (percentage >= 100) return 'bg-destructive';
  if (percentage >= 80) return 'bg-yellow-500';
  return 'bg-primary';
};
