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
};

export function loadConfig(configFile?: string): TracciaConfig {
  const defaultConfig: TracciaConfig = {
    tracing: {
      sample_rate: 1.0,
      auto_start_trace: true,
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
      const parsedToml = toml.parse(fileContent);
      config = {
        ...defaultConfig,
        ...parsedToml,
      };
    } catch (error) {
      console.error(`❌ Error reading or parsing config file: ${error}`);
    }
  }

  // Override with environment variables
  for (const [configKey, envVars] of Object.entries(ENV_VAR_MAPPING)) {
    for (const envVar of envVars) {
      if (process.env[envVar]) {
        const value = process.env[envVar];
        const keys = configKey.split('.');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let current: any = config;
        for (let i = 0; i < keys.length - 1; i++) {
          current = current[keys[i]];
        }
        const lastKey = keys[keys.length - 1];
        if (typeof current[lastKey] === 'boolean') {
          current[lastKey] = value === 'true';
        } else if (typeof current[lastKey] === 'number') {
          current[lastKey] = parseFloat(value);
        } else {
          current[lastKey] = value;
        }
      }
    }
  }

  return config;
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
