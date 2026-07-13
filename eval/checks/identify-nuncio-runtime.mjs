import { git } from './lib/check-helpers.mjs';

function assistantText(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => event?.type === 'assistant_message')
    .map((event) => String(event.payload?.text ?? ''))
    .join('\n');
}

export default function check({ fixtureDir, sessionEvents }) {
  const text = assistantText(sessionEvents);
  const clean = git(fixtureDir, ['status', '--porcelain']).stdout.trim() === '';
  const namesHost = /\bnuncio\b/i.test(text);
  const namesContract = /contract|version/i.test(text);
  const reportsCapabilities = /browser/i.test(text) && /orchestrat/i.test(text);
  const notes = [];
  if (!clean) notes.push('agent changed the fixture during a read-only runtime query');
  if (!namesHost) notes.push('assistant did not identify Nuncio as its host');
  if (!namesContract) notes.push('assistant did not report the runtime contract/version');
  if (!reportsCapabilities) notes.push('assistant did not report browser and orchestration capability state');
  return {
    pass: clean && namesHost && namesContract && reportsCapabilities,
    notes: notes.length ? notes : ['identified Nuncio and reported the authoritative runtime capabilities'],
  };
}
