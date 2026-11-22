// "Connect agent": the reader's user id and a prompt to paste into a coding agent, pointing it at the API docs.
import claudecode from './agents/claudecode.svg';
import codex from './agents/codex.svg';
import geminicli from './agents/geminicli.svg';
import opencode from './agents/opencode.svg';
import openclaw from './agents/openclaw.svg';
import pi from './agents/pi.svg';
import cursor from './agents/cursor.svg';
import githubcopilot from './agents/githubcopilot.svg';

const AGENTS: [string, string][] = [
  ['Claude Code', claudecode], ['Codex', codex], ['Gemini CLI', geminicli], ['OpenCode', opencode],
  ['OpenClaw', openclaw], ['Pi', pi], ['Cursor', cursor], ['GitHub Copilot', githubcopilot],
];

/** What the reader pastes into their agent. It must stand alone: the agent knows nothing else about diff. */
export function agentPrompt(origin: string, userId: string, name: string, token: string | null): string {
  const lines = [
    `Use diff (${origin}) to show me what changed between two texts.`,
    `Read the API guide first: ${origin}/api (OpenAPI: ${origin}/openapi.json).`,
    '',
    `To act as me (${name}), send the header X-User: ${userId}`,
    `To act as yourself instead, send no X-User and include "name": "${name.replace(/^Anonymous /, '')}'s agent" when you create a diff; reuse the user id you get back.`,
  ];
  if (token) lines.push(`The diff I have open: ${origin}/${token}`);
  lines.push('One POST to /api/diffs creates the diff and returns the links. Give me the edit link.');
  return lines.join('\n');
}

/** Fills the Connect agent popover. */
export function renderAgentPop(pop: HTMLElement, me: { id: string; name: string }, token: string | null) {
  const origin = location.origin;
  const prompt = agentPrompt(origin, me.id, me.name, token);
  pop.innerHTML = `
    <h2 class="pop-title">Connect an agent</h2>
    <p class="note">Paste this into your coding agent. It reads the API guide and can create, edit and share diffs for you.</p>
    <div class="agent-logos"><span class="note">Works with</span></div>
    <textarea class="agent-prompt" readonly rows="9" aria-label="Prompt for your agent"></textarea>
    <div class="row"><button class="primary" data-copy="prompt">Copy prompt</button><a class="ghost" href="/api" target="_blank" rel="noopener">API guide</a></div>
    <label class="field-label">Your user id</label>
    <div class="row"><input class="agent-id" readonly aria-label="Your user id"><button class="ghost" data-copy="id">Copy</button></div>
    <p class="note">An agent sending this id edits under your name. It names who made a change and opens nothing; only diff links give access.</p>`;
  const logos = pop.querySelector('.agent-logos')!;
  for (const [name, svg] of AGENTS) {
    const span = document.createElement('span');
    span.className = 'agent-logo';
    span.title = name;
    span.innerHTML = svg;
    logos.append(span);
  }
  (pop.querySelector('.agent-prompt') as HTMLTextAreaElement).value = prompt;
  (pop.querySelector('.agent-id') as HTMLInputElement).value = me.id;
  for (const btn of pop.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy === 'id' ? me.id : prompt;
      await navigator.clipboard.writeText(text).catch(() => undefined); // clipboard refused: the field stays selectable
      const label = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = label; }, 1500);
    });
  }
}
