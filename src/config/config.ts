import * as fs from 'fs';
import * as path from 'path';
import * as toml from 'toml';

export interface TracingConfig {
  api_key?: string;
  endpoint?: string;
  sample_rate?: number;
  auto_start_trace?: boolean;
  auto_trace_name?: string;
  use_otlp?: boolean;
  service_name?: string;
}

export interface ExportersConfig {
  enable_console?: boolean;
  enable_file?: boolean;
  file_exporter_path?: string;
  reset_trace_file?: boolean;
}

export interface InstrumentationConfig {
  enable_patching?: boolean;
  enable_token_counting?: boolean;
  enable_costs?: boolean;
  auto_instrument_tools?: boolean;
  max_tool_spans?: number;
  max_span_depth?: number;
  guardrail_heuristics?: boolean;
  redact_pii?: boolean;
}

export interface MetricsConfig {
  enable_metrics?: boolean;
  metrics_endpoint?: string;
  metrics_sample_rate?: number;
}

export interface RateLimitingConfig {
  max_spans_per_second?: number;
  max_queue_size?: number;
  max_block_ms?: number;
  max_export_batch_size?: number;
  schedule_delay_millis?: number;
}

export interface RuntimeConfig {
  session_id?: string;
  user_id?: string;
  tenant_id?: string;
  project_id?: string;
}

export interface LoggingConfig {
  debug?: boolean;
  enable_span_logging?: boolean;
}

export interface AdvancedConfig {
  attr_truncation_limit?: number;
}

export interface TracciaConfig {
  tracing: TracingConfig;
  exporters: ExportersConfig;
  instrumentation: InstrumentationConfig;
  rate_limiting: RateLimitingConfig;
  metrics: MetricsConfig;
  runtime: RuntimeConfig;
  logging: LoggingConfig;
  advanced: AdvancedConfig;
}

export const ENV_VAR_MAPPING: { [key: string]: string[] } = {
  'tracing.api_key': ['TRACCIA_API_KEY', 'AGENT_DASHBOARD_API_KEY'],
  'tracing.endpoint': ['TRACCIA_ENDPOINT', 'AGENT_DASHBOARD_ENDPOINT'],
  'tracing.sample_rate': ['TRACCIA_SAMPLE_RATE', 'AGENT_DASHBOARD_SAMPLE_RATE'],
  'tracing.use_otlp': ['TRACCIA_USE_OTLP'],
  // OTEL_SERVICE_NAME, then TRACCIA_AGENT_NAME, then TRACCIA_SERVICE_NAME (the order before TRC-296).
  'tracing.service_name': ['OTEL_SERVICE_NAME', 'TRACCIA_AGENT_NAME', 'TRACCIA_SERVICE_NAME'],
  'exporters.enable_console': ['TRACCIA_ENABLE_CONSOLE'],
  'exporters.enable_file': ['TRACCIA_ENABLE_FILE'],
  'exporters.file_exporter_path': ['TRACCIA_FILE_PATH'],
  'instrumentation.enable_token_counting': ['TRACCIA_ENABLE_TOKEN_COUNTING'],
  'instrumentation.enable_costs': ['TRACCIA_ENABLE_COSTS'],
  'instrumentation.guardrail_heuristics': ['TRACCIA_GUARDRAIL_HEURISTICS'],
  'instrumentation.redact_pii': ['TRACCIA_REDACT_PII'],
  'logging.debug': ['TRACCIA_DEBUG'],
  'logging.enable_span_logging': ['TRACCIA_ENABLE_SPAN_LOGGING'],
  'metrics.enable_metrics': ['TRACCIA_ENABLE_METRICS'],
  'metrics.metrics_endpoint': ['TRACCIA_METRICS_ENDPOINT'],
  'metrics.metrics_sample_rate': ['TRACCIA_METRICS_SAMPLE_RATE'],
  'rate_limiting.max_spans_per_second': ['TRACCIA_MAX_SPANS_PER_SECOND'],
  'rate_limiting.max_block_ms': ['TRACCIA_MAX_BLOCK_MS'],
};

/** How each environment value is parsed; keys not listed are strings. */
const ENV_VAR_TYPES: { [key: string]: 'boolean' | 'number' } = {
  'tracing.sample_rate': 'number',
  'tracing.use_otlp': 'boolean',
  'exporters.enable_console': 'boolean',
  'exporters.enable_file': 'boolean',
  'instrumentation.enable_token_counting': 'boolean',
  'instrumentation.enable_costs': 'boolean',
  'instrumentation.guardrail_heuristics': 'boolean',
  'instrumentation.redact_pii': 'boolean',
  'logging.debug': 'boolean',
  'logging.enable_span_logging': 'boolean',
  'metrics.enable_metrics': 'boolean',
  'metrics.metrics_sample_rate': 'number',
  'rate_limiting.max_spans_per_second': 'number',
  'rate_limiting.max_block_ms': 'number',
};

function parseEnvValue(configKey: string, value: string): string | number | boolean {
  switch (ENV_VAR_TYPES[configKey]) {
    case 'boolean':
      return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
    case 'number':
      return parseFloat(value);
    default:
      return value;
  }
}

export function loadConfig(configFile?: string): TracciaConfig {
  const defaultConfig: TracciaConfig = {
    tracing: {
      sample_rate: 1.0,
      auto_start_trace: false, // read by the Python SDK; Node never starts a root trace on init
      auto_trace_name: 'root',
      use_otlp: true,
    },
    exporters: {
      enable_console: false,
      enable_file: false,
      file_exporter_path: 'traces.jsonl',
      reset_trace_file: false,
    },
    instrumentation: {
      enable_patching: true,
      enable_token_counting: true,
      enable_costs: true,
      auto_instrument_tools: false,
      max_tool_spans: 100,
      max_span_depth: 10,
    },
    metrics: {
      enable_metrics: true,
      metrics_endpoint: undefined,
      metrics_sample_rate: 1.0,
    },
    rate_limiting: {
      max_queue_size: 5000,
      max_block_ms: 100,
      max_export_batch_size: 512,
      schedule_delay_millis: 5000,
    },
    runtime: {},
    logging: {
      debug: false,
      enable_span_logging: false,
    },
    advanced: {},
  };

  let config = defaultConfig;

  const configPath = configFile || findConfigFile();

  if (configPath) {
    try {
      const fileContent = fs.readFileSync(configPath, 'utf-8');
      const parsedToml = toml.parse(fileContent) as Record<string, unknown>;
      // Merge each section onto its defaults, so a section that sets some keys keeps the rest.
      const merged: Record<string, unknown> = { ...defaultConfig };
      for (const [section, value] of Object.entries(parsedToml)) {
        const base = merged[section];
        merged[section] =
          isPlainObject(base) && isPlainObject(value) ? { ...base, ...value } : value;
      }
      config = merged as unknown as TracciaConfig;
    } catch (error) {
      console.error(`❌ Error reading or parsing config file: ${error}`);
    }
  }

  // Override with environment variables. Of a key's aliases, the first one set wins.
  for (const [configKey, envVars] of Object.entries(ENV_VAR_MAPPING)) {
    const envVar = envVars.find((name) => process.env[name]);
    if (envVar === undefined) {
      continue;
    }
    const keys = configKey.split('.');
    let current = config as unknown as Record<string, unknown>;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!isPlainObject(current[keys[i]])) {
        current[keys[i]] = {};
      }
      current = current[keys[i]] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]] = parseEnvValue(configKey, process.env[envVar] as string);
  }

  return config;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function findConfigFile(): string | undefined {
  const currentDir = process.cwd();
  const homeDir = process.env.HOME || process.env.USERPROFILE;

  const searchPaths = [
    path.join(currentDir, 'traccia.toml'),
    homeDir ? path.join(homeDir, '.traccia', 'config.toml') : undefined,
  ].filter((p): p is string => Boolean(p));

  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return undefined;
}
