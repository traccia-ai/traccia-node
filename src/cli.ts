import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import {
  loadConfig,
  findConfigFile,
  ENV_VAR_MAPPING,
  TracciaConfig,
} from './config/config';

const program = new Command();
program.exitOverride();

program
  .name('traccia-ts')
  .description('Traccia SDK - Production-ready tracing for AI agents')
  .version('0.0.1');

program
  .command('check')
  .description('Verify connectivity to ingest endpoint')
  .option('--endpoint <url>', 'Override endpoint URL')
  .option('--api-key <key>', 'API key for authentication')
  .action(async (options) => {
    const config = loadConfig(options.config);
    const endpoint = options.endpoint || config.tracing.endpoint;

    if (!endpoint) {
      console.error('❌ No endpoint configured.');
      console.error(
        '   Set endpoint in traccia.toml or use --endpoint flag'
      );
      process.exit(1);
      return;
    }

    console.log(`🔍 Checking connectivity to ${endpoint}...`);

    try {
      const headers: { [key: string]: string } = {};
      const apiKey = options.apiKey || config.tracing.api_key;
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      await axios.head(endpoint, { headers, timeout: 5000 });
      console.log(`✅ Endpoint is reachable`);
      console.log('💡 Connectivity test successful!');
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        const { status } = error.response;
        if ([400, 401, 405].includes(status)) {
          console.log(`✅ Endpoint is reachable (HTTP ${status})`);
          if (status === 405) {
            console.log(
              '💡 Endpoint only accepts specific methods (expected for OTLP endpoints)'
            );
          } else if (status === 401) {
            console.log('⚠️  Authentication required - check your API key');
          } else if (status === 400) {
            console.log(
              '💡 Endpoint rejected test payload (expected for OTLP endpoints)'
            );
          }
          console.log('✅ Connectivity test successful!');
        } else {
          console.error(`❌ HTTP Error ${status}: ${error.response.statusText}`);
          process.exit(1);
          return;
        }
      } else {
        console.error(`❌ Connection failed: ${error}`);
        console.error(
          '   Make sure the endpoint is running and accessible'
        );
        process.exit(1);
        return;
      }
    }
  });

const configCommand = program
  .command('config')
  .description('Configuration management');

configCommand
  .command('init')
  .description('Create traccia.toml config file')
  .option('--force', 'Overwrite existing config file')
  .action((options) => {
    const configPath = path.join(process.cwd(), 'traccia.toml');

    if (fs.existsSync(configPath) && !options.force) {
      console.error('❌ Config file already exists at', configPath);
      console.error('   Use --force to overwrite');
      process.exit(1);
      return;
    }

    const configTemplate = `# Traccia SDK Configuration File
# Documentation: https://github.com/traccia-ai/traccia

[tracing]
# API key for authentication (required for SaaS, optional for open-source)
api_key = ""

# Endpoint URL for trace ingestion
# For local Tempo: endpoint = "http://localhost:4318/v1/traces"
# For local Jaeger: endpoint = "http://localhost:4318/v1/traces"
# endpoint = "http://localhost:4318/v1/traces"

# Sampling rate (0.0 to 1.0) - controls what percentage of traces are sent
sample_rate = 1.0

# Python SDK only: start one root trace on init for the whole run of a script (default: false).
# The Node SDK never does this: each top-level call is its own trace; group calls with runWithAutoTrace().
auto_start_trace = false

# Name for the auto-started root trace
auto_trace_name = "root"

# Use OTLP exporter (default: true)
# Set to false if using console or file exporter
use_otlp = true

# Service name (optional)
# service_name = "my-app"

[exporters]
# IMPORTANT: Only enable ONE exporter at a time (console, file, or OTLP via use_otlp)

# Enable console exporter for local debugging
enable_console = false

# Enable file exporter to write traces to local file
enable_file = false

# File path for file exporter (only used if enable_file = true)
file_exporter_path = "traces.jsonl"

# Reset/clear trace file on initialization
reset_trace_file = false

[instrumentation]
# Auto-patch popular libraries (OpenAI, Anthropic, requests)
enable_patching = true

# Count tokens for LLM calls
enable_token_counting = true

# Calculate costs for LLM calls
enable_costs = true

# Auto-instrument tool calls (experimental)
auto_instrument_tools = false

# Maximum number of tool spans to create
max_tool_spans = 100

# Maximum depth of nested spans
max_span_depth = 10

[rate_limiting]
# Maximum spans per second (uncomment to enable rate limiting)
# max_spans_per_second = 100.0

# Maximum queue size for buffered spans
max_queue_size = 5000

# Maximum milliseconds to block before dropping spans
max_block_ms = 100

# Maximum number of spans in a single export batch
max_export_batch_size = 512

# Delay in milliseconds between export batches
schedule_delay_millis = 5000

[runtime]
# Runtime metadata (optional - can be set per-session)
# session_id = ""
# user_id = ""
# tenant_id = ""
# project_id = ""

[logging]
# Enable debug logging
debug = false

# Enable span-level logging
enable_span_logging = false

[advanced]
# Maximum length for attribute values (uncomment to set limit)
# attr_truncation_limit = 1000
`;

    try {
      fs.writeFileSync(configPath, configTemplate, 'utf-8');
      console.log(`✅ Created config file at ${configPath}`);
      console.log('\n📝 Next steps:');
      console.log('   1. Edit the config file to add your API key and endpoint');
      console.log('   2. Run `traccia-ts doctor` to validate your configuration');
      console.log('   3. Run `traccia-ts check` to test connectivity');
    } catch (error) {
      console.error('❌ Failed to create config file:', error);
      process.exit(1);
      return;
    }
  });

program
  .command('doctor')
  .description('Validate configuration and diagnose issues')
  .option('--config <path>', 'Path to config file')
  .action((options) => {
    console.log('🩺 Running Traccia configuration diagnostics...\n');
    let issuesFound = 0;

    // 1. Check for config file
    const configFile = options.config || findConfigFile();
    if (configFile) {
      if (fs.existsSync(configFile)) {
        console.log(`✅ Found config file: ${configFile}`);
      } else {
        console.error(`❌ Specified config file not found: ${configFile}`);
        issuesFound++;
      }
    } else {
      console.log(
        '⚠️  No config file found (checked ./traccia.toml and ~/.traccia/config.toml)'
      );
      console.log('   Run `traccia-ts config init` to create one');
    }

    // 2. Check environment variables
    console.log('\n📋 Environment variables:');
    const foundEnvVars: string[] = [];
    for (const envVars of Object.values(ENV_VAR_MAPPING)) {
      for (const envVar of envVars) {
        if (process.env[envVar]) {
          foundEnvVars.push(envVar);
          console.log(`   ✅ ${envVar} is set`);
        }
      }
    }
    if (foundEnvVars.length === 0) {
      console.log('   ℹ️  No Traccia environment variables set');
    }

    // 3. Validate configuration
    console.log('\n🔍 Validating configuration...');
    const config: TracciaConfig = loadConfig(configFile);
    console.log('✅ Configuration loaded');

    // Print configuration summary
    console.log('\n📊 Configuration summary:');
    console.log(
      `   • API Key: ${
        config.tracing.api_key ? '✅ Set' : '❌ Not set'
      }`
    );
    console.log(
      `   • Endpoint: ${config.tracing.endpoint || '❌ Not set'}`
    );
    console.log(`   • Sample Rate: ${config.tracing.sample_rate}`);
    console.log(
      `   • OTLP Exporter: ${
        config.tracing.use_otlp ? '✅ Enabled' : '❌ Disabled'
      }`
    );
    console.log(
      `   • Console Exporter: ${
        config.exporters.enable_console ? '✅ Enabled' : '❌ Disabled'
      }`
    );
    console.log(
      `   • File Exporter: ${
        config.exporters.enable_file ? '✅ Enabled' : '❌ Disabled'
      }`
    );
    console.log(
      `   • Auto-patching: ${
        config.instrumentation.enable_patching ? '✅ Enabled' : '❌ Disabled'
      }`
    );

    // Check for potential issues
    if (config.tracing.use_otlp && !config.tracing.endpoint) {
      console.log(
        '\n⚠️  Warning: OTLP exporter is enabled but no endpoint is configured'
      );
      issuesFound++;
    }

    if (
      !config.tracing.use_otlp &&
      !config.exporters.enable_console &&
      !config.exporters.enable_file
    ) {
      console.log(
        "\n❌ Error: No exporter is enabled! Traces won't be exported anywhere."
      );
      issuesFound++;
    }

    if (config.rate_limiting.max_spans_per_second) {
      console.log(
        `\n   ℹ️  Rate limiting enabled: ${config.rate_limiting.max_spans_per_second} spans/sec`
      );
    }

    // 4. Environment variable mapping reference
    console.log('\n📖 Environment Variable Reference:');
    console.log('   Common variables:');
    console.log('   • TRACCIA_API_KEY or AGENT_DASHBOARD_API_KEY');
    console.log('   • TRACCIA_ENDPOINT or AGENT_DASHBOARD_ENDPOINT');
    console.log('   • TRACCIA_SAMPLE_RATE');
    console.log('   • TRACCIA_DEBUG');
    console.log(
      '\n   For a complete list, see: ENV_VAR_MAPPING in src/config/config.ts'
    );

    // Summary
    console.log('\n' + '='.repeat(60));
    if (issuesFound === 0) {
      console.log('✅ No issues found! Your configuration looks good.');
      console.log(
        '\n💡 Tip: Run `traccia-ts check` to test connectivity to your endpoint'
      );
    } else {
      console.log(
        `⚠️  Found ${issuesFound} issue(s). Please review the messages above.`
      );
      process.exit(1);
      return;
    }
  });

// Pricing commands
program
  .command('pricing')
  .description('Manage local pricing snapshot')
  .action(() => {
    console.log('💰 Pricing management commands:');
    console.log('   Use `traccia-ts pricing status` to show current snapshot info');
    console.log('   Use `traccia-ts pricing refresh` to download the latest pricing');
    console.log('   Use `traccia-ts pricing clear` to remove local cache');
  });

program
  .command('pricing:status')
  .description('Show current pricing source, age, and model count')
  .action(() => {
    const { getLocalCacheInfo, loadBundledPricing, getBundledGeneratedAt } = require('./config/pricing-config');
    
    const bundledModels = Object.keys(loadBundledPricing() || {});
    const bundledAge = getBundledGeneratedAt();
    console.log(`Bundled snapshot  : ${bundledModels.length} models, generated_at=${bundledAge || 'unknown'}`);
    console.log(`  (Bundled at SDK install time; refreshed on each SDK release.)`);

    const info = getLocalCacheInfo();
    if (info) {
      console.log(`\nLocal cache       : ${info.model_count} models, generated_at=${info.generated_at}`);
      console.log(`  path            : ${info.path}`);
      console.log(`  source          : ${info.source}`);
      if (info.source_url) {
        console.log(`  source_url      : ${info.source_url}`);
      }
    } else {
      console.log('\nLocal cache       : NOT PRESENT');
      console.log('  The SDK is using the BUNDLED snapshot.');
      console.log('  Run `traccia-ts pricing:refresh` to download the latest pricing.');
    }
  });

program
  .command('pricing:refresh')
  .description('Download the latest pricing and save to local cache')
  .option('--source <source>', 'Force fetching from specific source (upstream)')
  .action(async (options) => {
    const { fetchUpstreamPricing, fetchPlatformPricing, writeLocalCache } = require('./config/pricing-config');
    
    const apiKey = process.env.TRACCIA_API_KEY || process.env.AGENT_DASHBOARD_API_KEY;
    
    let snapshot: { models: Record<string, unknown>; generated_at: string; etag?: string; source_url?: string } | null = null;
    
    if (options.source !== 'upstream') {
      console.log('Fetching pricing from Traccia platform...');
      try {
        snapshot = await fetchPlatformPricing(apiKey);
        if (snapshot) {
          console.log('  Platform responded OK.');
        }
      } catch (e) {
        console.log(`  Could not reach platform: ${e}`);
      }
    }
    
    if (!snapshot) {
      if (options.source === 'upstream' || !snapshot) {
        console.log('Fetching from upstream pricing source...');
        snapshot = await fetchUpstreamPricing();
        if (snapshot) {
          snapshot = { ...snapshot, source_url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json' };
        }
      }
    }
    
    if (!snapshot) {
      console.log('Failed to fetch pricing from both platform and upstream source.');
      process.exit(1);
      return;
    }
    
    const cachePath = writeLocalCache(snapshot);
    console.log(`Pricing refreshed: ${Object.keys(snapshot.models).length} models`);
    console.log(`Saved to: ${cachePath}`);
  });

program
  .command('pricing:clear')
  .description('Delete local pricing cache (revert to bundled snapshot)')
  .action(() => {
    const { clearLocalCache, getCachePath } = require('./config/pricing-config');
    if (clearLocalCache()) {
      console.log(`Local pricing cache cleared (${getCachePath()}).`);
    } else {
      console.log('No local pricing cache found.');
    }
  });

const realProcessExit = process.exit.bind(process);

async function withScriptExits<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.exit;
  process.exit = ((code?: number) => {
    const error = new Error(
      code ? `The task script exited with status ${code}` : 'The task script exited before the run finished',
    );
    (error as Error & { tracciaExit?: number }).tracciaExit = code ?? 0;
    throw error;
  }) as typeof process.exit;
  try {
    return await fn();
  } finally {
    process.exit = previous;
  }
}

function scriptHalted(err: { tracciaExit?: number; message?: string }, output: string, writeSummary: Function) {
  const message = err.tracciaExit
    ? `The task script exited with status ${err.tracciaExit}`
    : 'The task script exited before the run finished';
  evalFailure(output, 3, 'task_error', message, writeSummary);
}

function evalFailure(output: string, code: number, name: string, message: string, writeSummary: Function) {
  const body = {
    exit_code: code,
    code: name,
    failures: [{ code: name, message }],
    quality_gate: false,
    label: 'Failed',
  };
  if (!writeSummary(output, body)) process.exit(5);
  console.error(message);
  process.exit(code);
}

async function resolveScorerIds(scorers: string[]) {
  const { BUILTIN_SCORERS } = await import('./eval/builtins');
  const { fetchScorer } = await import('./eval/client');
  const found: Record<string, string> = {};
  for (const name of scorers || []) {
    const text = String(name);
    if (text.startsWith('local:') || BUILTIN_SCORERS.has(text)) continue;
    try {
      const remote = await fetchScorer(text);
      if (remote?.id) found[text] = String(remote.id);
    } catch {
      // A missing scorer stays unresolved. The baseline check reports it.
    }
  }
  return found;
}

async function loadBaseline(options: any) {
  const { fetchExperiment } = await import('./eval/client');
  const { fetchPromptRuntime } = await import('./prompts/client');
  let experimentId = options.baselineExperiment;
  let panelIndex = options.baselinePanel;
  let promptVersionId: string | null = null;
  if (options.baselinePrompt) {
    try {
      const { payload } = await fetchPromptRuntime(options.baselinePrompt, { label: 'production' });
      experimentId = payload.evidence_experiment_id;
      if (!experimentId) return { missing: true };
      if (panelIndex == null && payload.evidence_panel_index != null) panelIndex = payload.evidence_panel_index;
      promptVersionId = payload.evidence_prompt_version_id ? String(payload.evidence_prompt_version_id) : null;
    } catch {
      return { missing: true };
    }
  }
  let experiment: any;
  try {
    experiment = await fetchExperiment(String(experimentId));
  } catch {
    return { missing: true };
  }
  const context = experiment.run_context || {};
  const panels = experiment.aggregates?.panels || [];
  if (panelIndex != null && Number(panelIndex) < 0) return { panel_required: true };
  if (panels.length > 1 && panelIndex == null) return { panel_required: true };
  if (panelIndex == null) panelIndex = panels.length ? Number(panels[0].panel_index || 0) : 0;
  const panel = panels.find((item: any) => Number(item.panel_index || 0) === Number(panelIndex));
  if (panels.length && !panel) return { missing: true };
  let measured: any = null;
  for (const item of context.panel_measurements || []) {
    if (item && Number(item.panel_index || 0) === Number(panelIndex)) {
      measured = item;
      break;
    }
  }
  if (!measured && Number(panelIndex) === 0 && !('panel_measurements' in context)) measured = context;
  measured = measured || {};
  return {
    experiment_id: String(experiment.id || experimentId),
    panel_index: Number(panelIndex),
    prompt_version_id: panel?.prompt_version_id || promptVersionId,
    dataset_fingerprint: context.dataset_fingerprint,
    dataset_verified: context.dataset_verified === true,
    scorer_evidence: context.scorer_evidence || [],
    scorers: panel?.scorers || [],
    latency_concurrency: context.latency_concurrency,
    mean_latency_ms: measured.mean_latency_ms,
    task_cost_usd: measured.task_cost_usd,
    task_cost_coverage: measured.task_cost_coverage,
    judge_cost_usd: measured.judge_cost_usd,
    judge_cost_coverage: measured.judge_cost_coverage,
    judge_definition_hashes: measured.judge_definition_hashes || [],
  };
}

program
  .command('eval')
  .description('Run an experiment and fail the process when a gate misses')
  .argument('<script>', 'Module that exports task')
  .requiredOption('--output <path>', 'Summary JSON path')
  .requiredOption('--dataset <name>', 'Dataset name or id')
  .option('--name <name>', 'Experiment title. Defaults to the script or dataset name followed by eval.')
  .option('--scorer <name...>', 'Scorer names')
  .option('--informational <name...>', 'Selected scorers that skip the pass-rate bar')
  .option('--min-pass-rate <rate>', 'Absolute pass rate', (value) => Number(value))
  .option('--max-drop <points>', 'Allowed drop in percentage points', (value) => Number(value))
  .option('--baseline-prompt <name>')
  .option('--baseline-experiment <id>')
  .option('--baseline-panel <index>', 'Baseline panel', (value) => Number(value))
  .option('--allow-dataset-change')
  .option('--allow-concurrency-mismatch')
  .option('--max-latency-increase <ratio>', 'Allowed latency increase', (value) => Number(value))
  .option('--max-task-cost-increase <ratio>', 'Allowed task cost increase', (value) => Number(value))
  .option('--max-judge-cost-increase <ratio>', 'Allowed judge cost increase', (value) => Number(value))
  .option('--prompt <name>', 'Prompt name to attach as promotion evidence')
  .option('--prompt-version <version>', 'Prompt version number', (value) => Number(value))
  .option('--prompt-label <label>', 'Prompt label, such as production')
  .action(async (script, options) => {
    const { applyBaseline, decide, preflight, reportFromRows, validateBaseline, writeSummary } = await import('./eval/gate');
    const gateOptions: {
      scorers: string[];
      informational: string[];
      min_pass_rate: number | undefined;
      max_drop: number | undefined;
      baseline_prompt: string | undefined;
      baseline_experiment: string | undefined;
      max_latency_increase: number | undefined;
      max_task_cost_increase: number | undefined;
      max_judge_cost_increase: number | undefined;
      unhashed_scorers: string[];
      scorer_ids: Record<string, string>;
    } = {
      scorers: options.scorer || [],
      informational: options.informational || [],
      min_pass_rate: options.minPassRate,
      max_drop: options.maxDrop,
      baseline_prompt: options.baselinePrompt,
      baseline_experiment: options.baselineExperiment,
      max_latency_increase: options.maxLatencyIncrease,
      max_task_cost_increase: options.maxTaskCostIncrease,
      max_judge_cost_increase: options.maxJudgeCostIncrease,
      unhashed_scorers: (options.scorer || [])
        .filter((name: string) => String(name).startsWith('local:'))
        .map((name: string) => String(name).slice('local:'.length)),
      scorer_ids: {},
    };
    const early = preflight(gateOptions);
    if (early) {
      if (!writeSummary(options.output, { ...early, label: 'Failed' })) process.exit(5);
      console.error(early.failures[0].message);
      process.exit(early.exit_code);
    }
    let baseline: any = null;
    if (options.baselinePrompt || options.baselineExperiment) {
      baseline = await loadBaseline(options);
      if (options.maxDrop != null) {
        gateOptions.scorer_ids = await resolveScorerIds(options.scorer || []);
      }
      const blocked = validateBaseline(baseline, gateOptions);
      if (blocked) {
        if (!writeSummary(options.output, { ...blocked, label: 'Failed' })) process.exit(5);
        console.error(blocked.failures[0].message);
        process.exit(blocked.exit_code);
      }
    }
    const onSigint = () => {
      process.exit = realProcessExit;
      evalFailure(options.output, 130, 'task_error', 'The eval was interrupted', writeSummary);
    };
    process.on('SIGINT', onSigint);
    let loaded: any;
    try {
      loaded = await withScriptExits(() => import(path.resolve(script)));
    } catch (err: any) {
      if (err?.tracciaExit != null) scriptHalted(err, options.output, writeSummary);
      evalFailure(options.output, 2, 'bad_flags', `Could not load the task script: ${err?.message || err}`, writeSummary);
    }
    const local = loaded.scorers || {};
    const { namedScorer } = await import('./eval/evaluate');
    const scorers = [];
    for (const name of options.scorer || []) {
      if (String(name).startsWith('local:')) {
        const key = String(name).slice('local:'.length);
        if (!local[key]) evalFailure(options.output, 2, 'unknown_scorer', `Unknown local scorer ${key}`, writeSummary);
        scorers.push(namedScorer(local[key], key));
      } else {
        scorers.push(name);
      }
    }
    if ((options.promptVersion != null || options.promptLabel) && !options.prompt) {
      evalFailure(options.output, 2, 'bad_flags', 'A prompt version needs a prompt name', writeSummary);
    }
    if (options.prompt && options.promptVersion == null && !String(options.promptLabel || '').trim()) {
      evalFailure(options.output, 2, 'bad_flags', 'Pass a prompt version or label', writeSummary);
    }
    const { experimentName } = await import('./eval/experimentName');
    const { evaluate } = await import('./eval/evaluate');
    const { EvaluateError } = await import('./eval/errors');
    const { providerKeysFromEnv } = await import('./eval/providerKeys');
    let providerKeys: Record<string, string> = {};
    try {
      providerKeys = providerKeysFromEnv();
    } catch (err: any) {
      evalFailure(options.output, 2, 'bad_flags', String(err?.message || err), writeSummary);
    }
    let result: any;
    try {
      result = await withScriptExits(() => evaluate({
        name: experimentName({ name: options.name, dataset: options.dataset, script }),
        data: options.dataset,
        task: loaded.task,
        scorers,
        prompt: options.prompt,
        promptVersion: options.promptVersion,
        promptLabel: options.promptLabel,
        providerKeys,
        persist: true,
        progress: true,
        runContext: {
          checkout_sha: process.env.TRACCIA_GIT_CHECKOUT_SHA,
          github_sha: process.env.TRACCIA_GIT_GITHUB_SHA,
          head_sha: process.env.TRACCIA_GIT_HEAD_SHA,
          head_ref: process.env.TRACCIA_GIT_HEAD_REF,
          base_ref: process.env.TRACCIA_GIT_BASE_REF,
          pr: process.env.TRACCIA_PR_NUMBER,
          repository: process.env.TRACCIA_GIT_REPOSITORY,
          actor: process.env.TRACCIA_GIT_ACTOR,
          ...(baseline
            ? {
                baseline_experiment_id: baseline.experiment_id,
                baseline_panel_index: baseline.panel_index,
                baseline_prompt_version_id: baseline.prompt_version_id,
              }
            : {}),
        },
      }));
    } catch (err: any) {
      if (err?.tracciaExit != null) scriptHalted(err, options.output, writeSummary);
      if (err instanceof EvaluateError) {
        evalFailure(options.output, 2, 'bad_flags', String(err.message || err), writeSummary);
      }
      evalFailure(options.output, 3, 'task_error', String(err?.message || err), writeSummary);
    }
    const stored = result.runContext || {};
    const report: Record<string, any> = {
      rows: result.rows,
      persist_error: result.persistError,
      dataset_drift: Boolean(stored.dataset_drift),
      dataset_verified: stored.dataset_verified,
      dataset_fingerprint: stored.dataset_fingerprint,
      experiment_id: result.experimentId,
      url: result.url,
      latency_concurrency: stored.latency_concurrency,
      task_errors: result.errors?.length ? 1 : 0,
      scorers: reportFromRows(
        result.rows || [],
        options.informational || [],
        (result.rows || []).map((row: any) => row.item_id),
        options.scorer || [],
      ),
      min_pass_rate: options.minPassRate,
      max_drop: options.maxDrop,
      allow_dataset_change: Boolean(options.allowDatasetChange),
      allow_concurrency_mismatch: Boolean(options.allowConcurrencyMismatch),
      max_latency_increase: options.maxLatencyIncrease,
      max_task_cost_increase: options.maxTaskCostIncrease,
      max_judge_cost_increase: options.maxJudgeCostIncrease,
      baseline_experiment_id: baseline?.experiment_id,
    };
    applyBaseline(report, baseline);
    const outcome = decide(report);
    if (!writeSummary(options.output, outcome)) process.exit(5);
    console.error(outcome.label || outcome.code);
    process.exit(outcome.exit_code);
  });

function outputFlag(argv: string[]): string | undefined {
  const index = argv.indexOf('--output');
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('-')) return argv[index + 1];
  return undefined;
}

async function runCli(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err: any) {
    if (err?.exitCode === 0 || err?.code === 'commander.helpDisplayed' || err?.code === 'commander.help') {
      process.exit(0);
    }
    const usage = typeof err?.code === 'string' && err.code.startsWith('commander.');
    const message = String(err?.message || err);
    const auth = /API key/i.test(message);
    const code = usage || auth ? 2 : 3;
    const name = code === 2 ? 'bad_flags' : 'task_error';
    const output = outputFlag(process.argv);
    if (output) {
      const { writeSummary } = await import('./eval/gate');
      const body = {
        exit_code: code,
        code: name,
        failures: [{ code: name, message }],
        quality_gate: false,
        label: 'Failed',
      };
      if (!writeSummary(output, body)) process.exit(5);
    }
    if (!usage) console.error(message);
    process.exit(code);
  }
}

void runCli();
