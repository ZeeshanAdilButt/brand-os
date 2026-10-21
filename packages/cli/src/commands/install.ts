import { join } from 'node:path';
import { ConfigSchema } from '@cph/daemon/config';
import { issueApiToken, type ApiTokenScope } from '@cph/daemon/keystore';
import { ensureMasterKey } from '@cph/daemon/secret-store';
import type { CliContext } from '../context.js';
import { registerClaudeCode } from '../install/claude-code.js';
import { mcpEntryPath } from '../install/claude-code.js';
import { desktopConfigPath, registerClaudeDesktop } from '../install/claude-desktop.js';
import { buildTaskXml, daemonMainPath, encodeTaskXml, LAUNCH_EXECUTABLE, launchArguments, schtasksCreateArgs, TASK_NAME, taskXmlPath } from '../install/task-scheduler.js';
import { guardCommand, registerUserSettings, userSettingsPath } from '../install/user-settings.js';
import { describeError, EXIT_OK, EXIT_PROBLEM } from './shared.js';

/** Spec R1, printed at the end of every install. */
export const RESIDUAL_RISK_NOTE = [
  'Residual risk (read this):',
  '  - The cph-guard hook and the ask rules are speed bumps, not walls. Claude runs as your Windows user,',
  '    so a determined or confused model can still read the keyring or call a platform directly.',
  '  - Your approval is the real gate: nothing is published until you click Approve in the dashboard or answer the approval prompt in Claude Code (or pass Windows Hello, when approval.mode is hello).',
  '  - Never run Claude in a permission-bypass mode while platforms are connected.',
];

interface Step {
  title: string;
  /** What it touches, one line each (printed before anything runs). */
  effects: string[];
  run(): Promise<void>;
}

/** `cph_<scope>_<43 base64url characters>`, the shape `issueApiToken` mints. */
function isValidToken(scope: ApiTokenScope, value: string | null): boolean {
  return value !== null && new RegExp(`^cph_${scope}_[A-Za-z0-9_-]{43}$`).test(value);
}

/** Marks a step that cannot run, without counting as a failure. */
class Skip extends Error {}

export async function runInstall(ctx: CliContext): Promise<number> {
  const mcpEntry = mcpEntryPath(ctx.repoRoot);
  const daemonMain = daemonMainPath(ctx.repoRoot);
  const xmlPath = taskXmlPath(ctx.stateDir);
  const config = ctx.loadConfig();
  const userId = ctx.env['USERNAME'] === undefined ? undefined : ctx.env['USERDOMAIN'] === undefined ? ctx.env['USERNAME'] : `${ctx.env['USERDOMAIN']}\\${ctx.env['USERNAME']}`;
  const configFile = join(ctx.stateDir, 'config.json');
  const cliPackageDir = join(ctx.repoRoot, 'packages', 'cli');
  const keystore = (): ReturnType<CliContext['keystore']> => ctx.keystore();

  const steps: Step[] = [
    {
      title: 'Create the master key',
      effects: ['Windows Credential Manager: adds "master-key" under service "content-powerhouse" if it is missing (an existing key is left alone).'],
      async run() {
        ensureMasterKey(keystore());
        ctx.out('  Master key ready.');
      },
    },
    {
      title: 'Create the API tokens',
      effects: [
        'Windows Credential Manager: adds "api-token:mcp" and "api-token:cli" if missing or malformed.',
        '  Valid tokens already there are kept unless you answer yes to a follow-up question about rotating them.',
      ],
      async run() {
        const scopes = ['mcp', 'cli'] as const satisfies readonly ApiTokenScope[];
        const broken = scopes.filter((scope) => !isValidToken(scope, keystore().get(`api-token:${scope}`)));
        for (const scope of broken) {
          issueApiToken(keystore(), scope);
          ctx.out(`  Created the ${scope} token (it is never shown).`);
        }
        const kept = scopes.filter((scope) => !broken.includes(scope));
        if (kept.length === 0) return;
        if (await ctx.prompt.confirm('  Rotate the mcp and cli API tokens? [y/N] ')) {
          for (const scope of scopes) issueApiToken(keystore(), scope);
          ctx.out('  Rotated both tokens. Restart Claude Code and Claude Desktop so their MCP servers pick up the new mcp token.');
        } else {
          ctx.out(`  Kept the existing ${kept.join(' and ')} token${kept.length === 1 ? '' : 's'}.`);
        }
      },
    },
    {
      title: 'Write config.json',
      effects: [`File: ${configFile} (only if it does not exist yet).`],
      async run() {
        if (ctx.files.exists(configFile)) {
          ctx.out('  config.json already exists; left as it is.');
          return;
        }
        ctx.files.writeFile(configFile, `${JSON.stringify(ConfigSchema.parse({}), null, 2)}\n`);
        ctx.out(`  Wrote ${configFile}.`);
      },
    },
    {
      title: 'Write the Task Scheduler definition',
      effects: [
        `File: ${xmlPath}`,
        `  runs at logon: ${LAUNCH_EXECUTABLE} ${launchArguments(ctx.nodePath, daemonMain)}`,
      ],
      async run() {
        const xml = buildTaskXml({ nodePath: ctx.nodePath, daemonMain, ...(userId === undefined ? {} : { userId }) });
        ctx.files.writeFile(xmlPath, encodeTaskXml(xml));
        ctx.out(`  Wrote ${xmlPath}.`);
      },
    },
    {
      title: 'Register the logon task with schtasks',
      effects: [`Windows Task Scheduler: creates or replaces the task "${TASK_NAME}" from the file above (schtasks /Create /XML /F).`],
      async run() {
        if (!ctx.files.exists(xmlPath)) throw new Skip('the task file from the previous step does not exist; run install again and say yes to it.');
        await ctx.execFile('schtasks', schtasksCreateArgs(xmlPath));
        ctx.out(`  Registered "${TASK_NAME}". It starts at your next sign-in, or now with: schtasks /Run /TN "${TASK_NAME}"`);
      },
    },
    {
      title: 'Link `cph` globally',
      effects: [`pnpm: runs \`pnpm link --global\` in ${cliPackageDir} (puts \`cph\` on PATH).`],
      async run() {
        try {
          await ctx.execFile('pnpm', ['link', '--global'], { cwd: cliPackageDir });
        } catch (error) {
          throw new Error(`pnpm link failed (${describeError(error)}). If pnpm has no global bin folder yet, run \`pnpm setup\`, open a new terminal, then try again.`);
        }
        ctx.out('  Linked. Open a new terminal to use `cph`.');
      },
    },
    {
      title: 'Register the MCP server with Claude Code (user scope)',
      effects: [`Claude Code: runs \`claude mcp add --scope user content-powerhouse -- node "${mcpEntry}"\` (writes ~/.claude.json).`],
      async run() {
        const result = await registerClaudeCode(ctx.execFile, mcpEntry);
        if (result.status === 'registered') ctx.out('  Registered with Claude Code.');
        else if (result.status === 'already-registered') ctx.out('  Claude Code already has content-powerhouse registered.');
        else {
          ctx.out('  `claude` is not on PATH. Run this yourself when it is:');
          ctx.out(`    ${result.command}`);
        }
      },
    },
    {
      title: 'Register the MCP server with Claude Desktop',
      effects: [
        `File: ${desktopConfigPath(ctx.appDataDir)} (merged, other servers untouched; a timestamped .bak is written first).`,
        '  Quit Claude Desktop fully (including its tray icon) before you say yes: a running Desktop can write its old config back over the merge.',
      ],
      async run() {
        const outcome = registerClaudeDesktop(ctx.files, ctx.appDataDir, mcpEntry, ctx.now());
        if (!outcome.changed) ctx.out('  Claude Desktop already lists content-powerhouse.');
        else {
          ctx.out(`  Updated ${outcome.path}${outcome.backup === undefined ? '' : ` (backup: ${outcome.backup})`}.`);
          ctx.out('  Start Claude Desktop again, then check that content-powerhouse is still listed in that file (and in Settings > Developer). If it is gone, quit Desktop and run install again.');
        }
      },
    },
    {
      title: 'Add the permission rules and the cph-guard hook to your Claude settings',
      effects: [
        `File: ${userSettingsPath(ctx.homeDir)} (merged, never replaced; a timestamped .bak is written first).`,
        ...(config.claude.askOnPublish
          ? ['  permissions.ask: mcp__content-powerhouse__publish, mcp__content-powerhouse__schedule']
          : ['  permissions.ask: skipped (claude.askOnPublish is false)']),
        `  hooks.PreToolUse: ${guardCommand(ctx.repoRoot)}`,
        '  (blocks claude-in-chrome on the dashboard port and shell commands that touch the content-powerhouse secrets)',
      ],
      async run() {
        const outcome = registerUserSettings(ctx.files, ctx.homeDir, { guardCommand: guardCommand(ctx.repoRoot), askOnPublish: config.claude.askOnPublish }, ctx.now());
        if (!outcome.changed) ctx.out('  Your Claude settings already have these entries.');
        else ctx.out(`  Updated ${outcome.path}${outcome.backup === undefined ? '' : ` (backup: ${outcome.backup})`}.`);
      },
    },
  ];

  ctx.out('cph install will make these changes, one at a time. You are asked before each; answer n to skip it.');
  ctx.out('');
  steps.forEach((step, i) => {
    ctx.out(`${i + 1}. ${step.title}`);
    for (const effect of step.effects) ctx.out(`     ${effect}`);
  });
  ctx.out(`${steps.length + 1}. Print the residual-risk note (no change).`);
  for (const [label, path] of [['MCP server', mcpEntry], ['daemon', daemonMain], ['guard hook', join(ctx.repoRoot, 'packages', 'cli', 'hooks', 'cph-guard.mjs')]] as const) {
    if (!ctx.files.exists(path)) ctx.err(`Note: the ${label} file is missing (${path}). Run \`pnpm build\` before relying on it.`);
  }
  ctx.out('');

  let failed = false;
  for (const [i, step] of steps.entries()) {
    const yes = await ctx.prompt.confirm(`[${i + 1}/${steps.length}] ${step.title}. Do it? [y/N] `);
    if (!yes) {
      ctx.out(`  Skipped step ${i + 1}.`);
      continue;
    }
    try {
      await step.run();
    } catch (error) {
      if (error instanceof Skip) {
        ctx.out(`  Skipped: ${error.message}`);
      } else {
        failed = true;
        ctx.err(`  Step ${i + 1} failed: ${describeError(error)}`);
      }
    }
  }

  ctx.out('');
  for (const line of RESIDUAL_RISK_NOTE) ctx.out(line);
  return failed ? EXIT_PROBLEM : EXIT_OK;
}
