import { trace, Span, SpanStatusCode, Tracer } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const isProduction = process.env.NODE_ENV === 'production';

const traceExporter = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || isProduction)
  ? new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
    })
  : new ConsoleSpanExporter();

export const sdk = new NodeSDK({
  traceExporter,
  serviceName: 'ecomgear-server',
});

try {
  sdk.start();
  console.log('[Telemetry] OpenTelemetry SDK initialized successfully');
} catch (error) {
  console.error('[Telemetry] Failed to initialize OpenTelemetry SDK:', error);
}

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('[Telemetry] OpenTelemetry SDK shut down cleanly'))
    .catch((err) => console.error('[Telemetry] Error shutting down OpenTelemetry SDK', err));
});

export const tracer: Tracer = trace.getTracer('ecomgear-server', '1.0.0');

/**
 * Executes an async function within an active OpenTelemetry span.
 * Automatically manages span lifecycle, status codes, and exception recording.
 */
export async function traceSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const cleanAttributes: Record<string, string | number | boolean> = {};
  for (const [key, val] of Object.entries(attributes)) {
    if (val !== undefined && val !== null) {
      cleanAttributes[key] = val;
    }
  }

  return tracer.startActiveSpan(name, { attributes: cleanAttributes }, async (span: Span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (error as Error).message,
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
