import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SCENARIOS,
  STEER_SUGGESTIONS,
  steerBlocks,
  type DemoBlock,
  type DemoScenario,
} from '../lib/demo-script';

/**
 * The landing hero's interactive demo — a playable Nuncio session. Pick a task
 * and the "agent" streams a transcript block by block (thinking → tools → diff →
 * test result → summary); the session pill moves RUNNING → IDLE; when it settles
 * you can steer it with a follow-up and watch it continue. Deterministic content
 * and timing live in ../lib/demo-script (unit-tested); this component only drives
 * reveal timing and user input.
 */

type TimelineBlock = DemoBlock;

function buildTimeline(scenario: DemoScenario): TimelineBlock[] {
  return [{ kind: 'user', delayMs: 0, text: scenario.prompt }, ...scenario.blocks];
}

export function InteractiveDemo() {
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const scenario = SCENARIOS[scenarioIndex];

  const [timeline, setTimeline] = useState<TimelineBlock[]>(() => buildTimeline(scenario));
  const [revealed, setRevealed] = useState(1); // prompt shown immediately
  const [steerValue, setSteerValue] = useState('');
  const revealedRef = useRef(revealed);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const streaming = revealed < timeline.length;
  const status = streaming ? 'RUNNING' : 'IDLE';

  const selectScenario = useCallback((index: number) => {
    setScenarioIndex(index);
    setTimeline(buildTimeline(SCENARIOS[index]));
    setRevealed(1);
    setSteerValue('');
  }, []);

  const replay = useCallback(() => {
    setTimeline(buildTimeline(scenario));
    setRevealed(1);
    setSteerValue('');
  }, [scenario]);

  const steer = useCallback(
    (message: string) => {
      const trimmed = message.trim();
      if (!trimmed || streaming) return;
      setTimeline((prev) => [...prev, ...steerBlocks(trimmed)]);
      setSteerValue('');
    },
    [streaming],
  );

  useEffect(() => {
    revealedRef.current = revealed;
  }, [revealed]);

  // Whenever the timeline changes (new scenario, replay, or a steer appends
  // blocks), schedule the reveal of every not-yet-shown block up front at its
  // cumulative delay. Scheduling in one pass — rather than re-arming a timer on
  // each reveal — keeps streaming deterministic under fake timers.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let cumulative = 0;
    for (let i = revealedRef.current; i < timeline.length; i++) {
      cumulative += timeline[i].delayMs;
      const target = i + 1;
      timers.push(setTimeout(() => setRevealed((r) => Math.max(r, target)), cumulative));
    }
    return () => timers.forEach(clearTimeout);
  }, [timeline]);

  // Keep the transcript scrolled to the latest block.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [revealed, timeline]);

  const visible = useMemo(() => timeline.slice(0, revealed), [timeline, revealed]);

  return (
    <div className="demo" aria-label="Interactive Nuncio session demo">
      <div className="demo-chips" role="tablist" aria-label="Try a task">
        {SCENARIOS.map((s, i) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={i === scenarioIndex}
            className={`demo-chip${i === scenarioIndex ? ' on' : ''}`}
            onClick={() => selectScenario(i)}
          >
            {s.chip}
          </button>
        ))}
        <button className="demo-replay" onClick={replay} aria-label="Replay this task">
          ↻ Replay
        </button>
      </div>

      <div className="demo-panel">
        <div className="demo-h">
          <span className="demo-title">{scenario.prompt}</span>
          <span className={`demo-pill ${status === 'RUNNING' ? 'run' : ''}`}>
            <span className="sd" />
            {status}
          </span>
        </div>

        <div className="demo-body" ref={bodyRef}>
          {visible.map((block, i) => (
            <Block key={i} block={block} last={i === visible.length - 1} streaming={streaming} />
          ))}
          {streaming && <div className="demo-typing" aria-hidden="true">agent is working<span className="dots">…</span></div>}
        </div>

        <div className="demo-composer">
          <div className="demo-input-row">
            <input
              className="demo-input"
              value={steerValue}
              placeholder={streaming ? 'Agent is working…' : 'Steer the agent — add context, change direction…'}
              disabled={streaming}
              onChange={(e) => setSteerValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') steer(steerValue);
              }}
              aria-label="Steer the agent"
            />
            <button
              className="demo-send"
              disabled={streaming || steerValue.trim().length === 0}
              onClick={() => steer(steerValue)}
              aria-label="Send steer"
            >
              ↵
            </button>
          </div>
          <div className="demo-composer-foot">
            <span className="demo-model">{scenario.model}</span>
            <span className="demo-suggests">
              {!streaming &&
                STEER_SUGGESTIONS.map((s) => (
                  <button key={s} className="demo-suggest" onClick={() => steer(s)}>
                    {s}
                  </button>
                ))}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Block({
  block,
  last,
  streaming,
}: {
  block: TimelineBlock;
  last: boolean;
  streaming: boolean;
}) {
  switch (block.kind) {
    case 'user':
      return <div className="demo-user">{block.text}</div>;
    case 'thinking':
      return (
        <div className="demo-thinking">
          <span className="demo-kind">thought</span>
          {block.text}
        </div>
      );
    case 'assistant':
      return (
        <div className="demo-assistant">
          {block.text}
          {last && streaming && <span className="demo-caret" />}
        </div>
      );
    case 'tools':
      return (
        <div className="demo-tools">
          {block.tools?.map((tool, i) => (
            <div key={i} className="demo-tool">
              <span className="v">{tool.verb}</span>
              <span className="t">{tool.target}</span>
            </div>
          ))}
          {block.diff && (
            <div className="demo-diff">
              <div className="demo-diff-file">{block.diff.file}</div>
              {block.diff.del.map((line, i) => (
                <div key={`d${i}`} className="demo-diff-line del">
                  <span className="pre">−</span>
                  {line}
                </div>
              ))}
              {block.diff.add.map((line, i) => (
                <div key={`a${i}`} className="demo-diff-line add">
                  <span className="pre">+</span>
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    case 'result':
      return (
        <div className={`demo-result${block.result?.ok ? ' ok' : ''}`}>
          <span className="demo-result-dot" />
          {block.result?.label}
        </div>
      );
    default:
      return null;
  }
}
