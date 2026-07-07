// Hidden layer for use-project-facts (and its control variant): the seeded fact
// says "run codegen before build". Prove the engine obeyed it — over the ordered
// tool_start events, a command containing 'codegen' must precede the final
// command containing 'build'. Without the fact the engine typically runs build
// alone (control), which this ordering check rejects.
function toolCommands(events) {
  // Flatten each tool_start into a searchable command string (tool + input).
  return (Array.isArray(events) ? events : [])
    .filter((e) => e?.type === 'tool_start')
    .map((e) => `${e.payload?.tool ?? ''} ${JSON.stringify(e.payload?.input ?? '')}`);
}

export default function check({ sessionEvents }) {
  const notes = [];
  const cmds = toolCommands(sessionEvents);

  const buildIdxs = cmds.map((c, i) => (/\bbuild\b/.test(c) ? i : -1)).filter((i) => i >= 0);
  const codegenIdxs = cmds.map((c, i) => (/codegen/.test(c) ? i : -1)).filter((i) => i >= 0);

  if (buildIdxs.length === 0) {
    notes.push('no build command observed in tool events');
    return { pass: false, notes };
  }
  const lastBuild = buildIdxs[buildIdxs.length - 1];
  const codegenBeforeBuild = codegenIdxs.some((i) => i < lastBuild);

  if (codegenIdxs.length === 0) notes.push('no codegen command observed (the seeded fact was not obeyed)');
  else if (!codegenBeforeBuild) notes.push('codegen ran but not before the final build (order violates the fact)');

  const pass = codegenBeforeBuild;
  if (pass) notes.push('codegen preceded the final build (project fact obeyed)');
  return { pass, notes };
}
