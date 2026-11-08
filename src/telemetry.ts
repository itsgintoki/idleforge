const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint !== undefined && endpoint !== "") {
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "idleforge",
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();

  const shutdown = (): void => {
    void sdk.shutdown().catch(() => undefined);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
