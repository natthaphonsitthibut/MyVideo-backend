import { readdir } from 'node:fs/promises';
import { LlmCallError, type LlmTier } from '@myvideo/domain';
import { runProcess, withTempDir } from '../process/run-process.js';
import { type AdapterCall, type AdapterResult, type LlmAdapter, OneAtATime } from './adapter.js';

/**
 * `LLM_MODE=local-agent` with `LOCAL_AGENT_CLI=claude` (development only, D-009): the Claude Code CLI run headless
 * with a JSON schema, no tools, no session, no settings/MCP, in a fresh empty directory — the verified call of
 * the `llm-local-agent` skill (CLI 2.1.322). Uses the developer's own CLI login; never a key.
 */
export const CLAUDE_CLI_DEFAULT_MODEL = 'claude-sonnet-5-5';

/** Runs a CLI and returns its full stdout. Replaced by recorded output in tests. */
export type CliExec = (
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<{ code: number; stdout: string; stderrTail: string }>;

export const realCliExec: CliExec = async (command, args, cwd, timeoutMs, signal) => {
  const chunks: Buffer[] = [];
  const r = await runProcess(command, args, { cwd, timeoutMs, signal, onStdoutData: (c) => chunks.push(c) });
  return { code: r.code, stdout: Buffer.concat(chunks).toString('utf8'), stderrTail: r.stderrTail };
};

export type ClaudeCliOptions = {
  command?: string;
  models?: Partial<Record<LlmTier, string>>;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs?: number;
  exec?: CliExec;
};

/** The CLI's stdout JSON (`--output-format json`), the fields we use. */
type ClaudeCliOutput = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

export function claudeCliArgs(c: AdapterCall, effort: string): string[] {
  const prompt = c.system ? `${c.system}\n\n${c.prompt}` : c.prompt;
  return [
    '-p',
    prompt,
    '--model',
    c.model,
    '--effort',
    effort,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(c.jsonSchema),
    '--tools',
    '',
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--strict-mcp-config',
  ];
}

/** Turns the CLI's stdout into an adapter result; throws LlmCallError for anything but a successful answer. */
export function parseClaudeCliOutput(stdout: string): AdapterResult {
  let out: ClaudeCliOutput;
  try {
    out = JSON.parse(stdout) as ClaudeCliOutput;
  } catch {
    throw new LlmCallError(`local agent printed no JSON (${stdout.slice(0, 120)})`, true);
  }
  if (out.is_error !== false || out.subtype !== 'success') {
    throw new LlmCallError(
      `local agent call failed (${out.subtype ?? 'unknown'}): ${out.result ?? ''}`,
      true,
    );
  }
  let output = out.structured_output;
  if (output === undefined && typeof out.result === 'string') {
    try {
      output = JSON.parse(out.result);
    } catch {
      output = out.result;
    }
  }
  const u = out.usage ?? {};
  return {
    output,
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      costUsdEstimate: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : null,
    },
  };
}

export class ClaudeCliAdapter implements LlmAdapter {
  readonly mode = 'local-agent' as const;
  private readonly queue = new OneAtATime();
  private readonly command: string;
  private readonly models: Record<LlmTier, string>;
  private readonly effort: string;
  private readonly timeoutMs: number;
  private readonly exec: CliExec;

  constructor(opts: ClaudeCliOptions = {}) {
    this.command = opts.command ?? 'claude';
    this.models = {
      fast: opts.models?.fast ?? CLAUDE_CLI_DEFAULT_MODEL,
      smart: opts.models?.smart ?? CLAUDE_CLI_DEFAULT_MODEL,
    };
    this.effort = opts.effort ?? 'medium';
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.exec = opts.exec ?? realCliExec;
  }

  modelFor(tier: LlmTier): string {
    return this.models[tier];
  }

  call(c: AdapterCall): Promise<AdapterResult> {
    return this.queue.run(() =>
      withTempDir('myvideo-llm-', async (dir) => {
        c.signal?.throwIfAborted();
        if ((await readdir(dir)).length !== 0) throw new Error('local agent work dir must be empty');
        let r: Awaited<ReturnType<CliExec>>;
        try {
          r = await this.exec(this.command, claudeCliArgs(c, this.effort), dir, this.timeoutMs, c.signal);
        } catch (err) {
          throw new LlmCallError(`local agent did not run: ${(err as Error).message}`, true);
        }
        if (r.code !== 0 && r.stdout.trim() === '') {
          throw new LlmCallError(`local agent exited ${r.code}: ${r.stderrTail.slice(-300)}`, true);
        }
        return parseClaudeCliOutput(r.stdout);
      }),
    );
  }
}
