import type { Span } from '@opentelemetry/api';

export interface StepMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheHits?: number;
  stepCostUsd: number;
}

/**
 * Per-run agent execution metrics collector.
 * Tracks aggregate token counts, API cost estimates, step iteration counts,
 * and updates OpenTelemetry spans upon run completion.
 */
export class AgentMetrics {
  private totalInputTokens: number = 0;
  private totalOutputTokens: number = 0;
  private totalCacheHits: number = 0;
  private totalCostUsd: number = 0;
  private stepCount: number = 0;

  constructor(public readonly projectId: string) {}

  /**
   * Record metrics from a single completed agent step or LLM call.
   */
  public recordStep(metrics: StepMetrics): void {
    this.stepCount += 1;
    this.totalInputTokens += metrics.inputTokens || 0;
    this.totalOutputTokens += metrics.outputTokens || 0;
    this.totalCacheHits += metrics.cacheHits || 0;
    this.totalCostUsd += metrics.stepCostUsd || 0;
  }

  public getTotalCost(): number {
    return Number(this.totalCostUsd.toFixed(6));
  }

  public getTotalInputTokens(): number {
    return this.totalInputTokens;
  }

  public getTotalOutputTokens(): number {
    return this.totalOutputTokens;
  }

  public getTotalCacheHits(): number {
    return this.totalCacheHits;
  }

  public getStepCount(): number {
    return this.stepCount;
  }

  /**
   * Finalize active OpenTelemetry span with telemetry attributes.
   */
  public finalizeRunSpan(span: Span): void {
    if (!span) return;
    span.setAttributes({
      'agent.projectId': this.projectId,
      'agent.totalCostUsd': this.getTotalCost(),
      'agent.totalSteps': this.stepCount,
      'agent.inputTokens': this.totalInputTokens,
      'agent.outputTokens': this.totalOutputTokens,
      'agent.cacheHits': this.totalCacheHits,
    });
  }
}
