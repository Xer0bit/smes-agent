import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';
import { Loader2, CheckCircle, XCircle, AlertCircle } from 'lucide-react';

const BatchValidate = () => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<any>(null);

  const runBatchValidation = async () => {
    setIsProcessing(true);
    setResults(null);
    
    toast.info('Starting batch validation...', {
      description: 'This may take several minutes depending on the number of revisions'
    });

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/batch-validate-revisions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
        }
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Batch validation failed');
      }

      setResults(data);
      toast.success('Batch validation complete!', {
        description: `Processed ${data.stats.processed}/${data.stats.total} revisions`
      });
    } catch (error) {
      console.error('Batch validation error:', error);
      toast.error('Failed to run batch validation', {
        description: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Batch Validate Revisions</h1>
          <p className="text-muted-foreground">
            Run debug-sandbox validation on all existing revisions to ensure they're Sandpack-compatible
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Validation Process</CardTitle>
            <CardDescription>
              This will process all revisions in the database, validate their files, fix compatibility issues, and update the database
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={runBatchValidation}
              disabled={isProcessing}
              className="w-full"
              size="lg"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing revisions...
                </>
              ) : (
                'Start Batch Validation'
              )}
            </Button>

            {isProcessing && (
              <div className="text-sm text-muted-foreground text-center">
                This may take several minutes. Please wait...
              </div>
            )}
          </CardContent>
        </Card>

        {results && (
          <Card>
            <CardHeader>
              <CardTitle>Results</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 border rounded-none">
                  <div className="text-2xl font-bold">{results.stats.total}</div>
                  <div className="text-sm text-muted-foreground">Total</div>
                </div>
                <div className="p-4 border rounded-none bg-green-50 dark:bg-green-950">
                  <div className="text-2xl font-bold text-green-700 dark:text-green-300">
                    {results.stats.processed}
                  </div>
                  <div className="text-sm text-muted-foreground">Processed</div>
                </div>
                <div className="p-4 border rounded-none bg-red-50 dark:bg-red-950">
                  <div className="text-2xl font-bold text-red-700 dark:text-red-300">
                    {results.stats.failed}
                  </div>
                  <div className="text-sm text-muted-foreground">Failed</div>
                </div>
                <div className="p-4 border rounded-none bg-yellow-50 dark:bg-yellow-950">
                  <div className="text-2xl font-bold text-yellow-700 dark:text-yellow-300">
                    {results.stats.skipped}
                  </div>
                  <div className="text-sm text-muted-foreground">Skipped</div>
                </div>
              </div>

              <div className="text-sm text-muted-foreground">
                Total time: {(results.stats.total_time_ms / 1000).toFixed(2)}s
              </div>

              {results.details && results.details.length > 0 && (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  <h3 className="font-semibold">Details</h3>
                  {results.details.map((detail: any, index: number) => (
                    <div
                      key={index}
                      className="p-3 border rounded-none text-sm flex items-start gap-3"
                    >
                      {detail.status === 'success' ? (
                        <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                      ) : detail.status === 'failed' ? (
                        <XCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1">
                        <div className="font-mono text-xs text-muted-foreground">
                          {detail.revision_id}
                        </div>
                        {detail.status === 'success' && detail.validation && (
                          <div className="text-xs mt-1">
                            Fixed {detail.validation.issues_fixed} issue(s) •{' '}
                            {detail.validation.sandpack_compatible ? '✓ Compatible' : '⚠ Incompatible'}
                          </div>
                        )}
                        {detail.status === 'failed' && (
                          <div className="text-xs text-red-600 dark:text-red-400 mt-1">
                            {detail.error}
                          </div>
                        )}
                        {detail.status === 'skipped' && (
                          <div className="text-xs text-yellow-600 dark:text-yellow-400 mt-1">
                            {detail.reason}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};

export default BatchValidate;
