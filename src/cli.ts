#!/usr/bin/env node

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
        }
      } else {
        console.error(`❌ Connection failed: ${error}`);
        console.error(
          '   Make sure the endpoint is running and accessible'
        );
        process.exit(1);
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

# Auto-start a root trace on init (default: true)
auto_start_trace = true

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

program.parse(process.argv);
