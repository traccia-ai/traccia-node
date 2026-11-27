import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const cli = path.join(__dirname, '../../dist/cli.js');

function run(args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      status: err.status as number,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || ''),
    };
  }
}

describe('published CLI', () => {
  test('eval --help exits 0', () => {
    expect(fs.existsSync(cli)).toBe(true);
    const result = run(['eval', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--output');
  });

  test('--version prints the package version', () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    const result = run(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  });

  test('an unknown flag exits 2 and writes a summary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-cli-'));
    const output = path.join(dir, 'summary.json');
    const result = run(['eval', 'task.mjs', '--output', output, '--dataset', 'demo', '--nope']);
    expect(result.status).toBe(2);
    const body = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(body.exit_code).toBe(2);
    expect(body.code).toBe('bad_flags');
  });

  test('a script that exits during load writes a summary and exits 3', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-cli-'));
    const script = path.join(dir, 'task.mjs');
    const output = path.join(dir, 'summary.json');
    fs.writeFileSync(script, 'process.exit(0);\nexport function task() { return "ok"; }\n');
    const result = run(['eval', script, '--output', output, '--dataset', 'demo']);
    expect(result.status).toBe(3);
    const body = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(body.exit_code).toBe(3);
    expect(body.code).toBe('task_error');
  });
});
