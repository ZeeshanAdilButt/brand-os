import type { ConnectorDefinition } from './types';
import { AUTH_KIND_LABELS } from './types';

/**
 * The setup guide for a person's own browser agent. It lists the exact steps to follow on the platform's site and says,
 * in so many words, that the owner types every secret themselves: nothing sensitive is written in the guide, asked for
 * in chat, or sent through an agent. The agent is a pair of hands on the platform's pages, never a courier for secrets.
 */
export function setupGuideFor(def: ConnectorDefinition, redirectUri: string | null): string {
  const lines: string[] = [];
  lines.push(`Help me set up access for ${def.name} so my own app (Brand OS) can connect to it. I am signed in in this browser. Method: ${AUTH_KIND_LABELS[def.kind]}.`, '');

  if (def.kind === 'manual_only') {
    lines.push(`${def.name} has no connection to make: ${def.manual?.reason ?? ''}`, '', 'Do this and nothing else:');
    (def.manual?.handoff ?? []).forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    lines.push(`Start at: ${def.manual?.openUrl ?? def.docsUrl}`);
  } else {
    const steps: { title: string; body: string; linkUrl?: string | undefined }[] = [];
    if (def.oauth) steps.push(...def.oauth.appSteps);
    if (def.device && !def.oauth) steps.push(...def.device.appSteps);
    steps.push(...def.steps);
    lines.push('Do exactly these steps, in order, and nothing else:');
    steps.forEach((step, i) => lines.push(`${i + 1}. ${step.title}. ${step.body}${step.linkUrl ? ` Start at: ${step.linkUrl}` : ''}`));
    if (redirectUri && def.oauth && !def.oauth.perInstance) {
      lines.push('', `When the platform asks for a redirect or callback address, enter exactly: ${redirectUri}`);
    }
    const asked = def.scopes.filter((s) => s.required).map((s) => s.name);
    if (asked.length > 0) lines.push('', `Allow only these permissions: ${asked.join(', ')}. Do not tick any other permission.`);
  }

  lines.push(
    '',
    'Rules:',
    '- I type every secret myself. Never ask me to paste a key, token, secret or password into this chat, and never write one in your replies.',
    '- When the platform shows a key, token, client secret or code, stop and tell me which field to copy. I will paste it into the secure field in Brand OS myself.',
    '- Never post, publish, send or change anything on my account other than creating the one app, key or token above.',
    '- If a step asks for a payment, a verification code, or a decision about billing or privacy, stop and ask me.',
    `- Official documentation: ${def.docsUrl}`,
  );
  return lines.join('\n');
}
