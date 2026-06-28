import { AnthropicLogo, OpenAILogo, GeminiLogo, CursorLogo } from './components/logos';
import { ChangelogSection } from './components/changelog-section';

const REPO_URL = 'https://github.com/oscarlehuu/nuncio';

/**
 * Nuncio landing page — a self-hosted, mobile-first web app for delegating
 * tasks to AI coding agents. Static site deployed to GitHub Pages; the
 * Changelog section reads CHANGELOG.md at build time and updates automatically
 * on every merge to main.
 */
export function App() {
  return (
    <>
      <Nav />
      <Hero />
      <HowItWorks />
      <SelfHosted />
      <MobilePWA />
      <SteerFsm />
      <RealtimeReplay />
      <Changelog />
      <Faq />
      <FinalCta />
      <Footer />
    </>
  );
}

/* ============ Nav ============ */
function Nav() {
  return (
    <nav className="nav">
      <div className="wrap nav-inner">
        <a className="brand" href="#">
          <span className="brand-mark" />
          nuncio
        </a>
        <div className="nav-links">
          <a href="#how-it-works">How it works</a>
          <a href="#selfhosted">Self-hosted</a>
          <a href="#changelog">Changelog</a>
          <a href="#faq">FAQ</a>
        </div>
        <div className="nav-cta">
          <a className="btn btn-ghost btn-mono" href={REPO_URL}>
            GitHub
          </a>
        </div>
      </div>
    </nav>
  );
}

/* ============ Hero ============ */
function Hero() {
  return (
    <header className="hero">
      <div className="wrap hero-inner">
        <div className="eyebrow">Self-hosted · Mobile-first · MIT</div>
        <h1>Your AI coding agent, running at home — driven from your phone.</h1>
        <p className="lede">
          Delegate from your phone. The agent keeps coding while you're away. Steer it mid-task.
        </p>
        <div className="hero-cta">
          <a className="btn btn-primary btn-mono" href={REPO_URL}>
            Star on GitHub →
          </a>
        </div>
      </div>
      <div className="wrap">
        <div className="diptych">
          {/* LEFT: phone */}
          <div className="pane">
            <div className="pane-h">
              <span>nuncio</span>
              <span className="where">iphone · café</span>
            </div>
            <div className="pane-body">
              <div className="ph-session">
                <div className="top">
                  <span className="t">Fix empty-array edge case</span>
                  <span className="row-status">
                    <span className="sd run" />
                    <span className="live-tag">RUN</span>
                  </span>
                </div>
                <div className="meta">cursor:composer-2 · 14m</div>
              </div>
              <div className="ph-session">
                <div className="top">
                  <span className="t">Refactor auth module</span>
                  <span className="row-status">
                    <span className="sd" />
                    IDLE
                  </span>
                </div>
                <div className="meta">pi:claude-sonnet-4 · 2h</div>
              </div>
              <div className="ph-session">
                <div className="top">
                  <span className="t">Add landing page</span>
                  <span className="row-status">
                    <span className="sd" />
                    ARCH
                  </span>
                </div>
                <div className="meta">cursor:composer-2 · yest</div>
              </div>
              <div className="ph-steer">
                <span>also handle empty array…</span>
                <span className="arr">↵</span>
              </div>
            </div>
            <div className="pane-foot">you · out and about</div>
          </div>

          {/* connecting tailnet */}
          <div className="tailnet">
            <span className="tailnet-tag">tailnet</span>
          </div>

          {/* RIGHT: mac */}
          <div className="pane">
            <div className="pane-h">
              <span>nuncio</span>
              <span className="where">mac mini · home</span>
            </div>
            <div className="pane-body">
              <div className="mc-line">
                <span className="row-status">
                  <span className="sd run" />
                  <span className="live-tag">RUNNING</span>{' '}
                  <span style={{ color: 'var(--fg-faint)' }}>· composer-2</span>
                </span>
              </div>
              <div className="mc-line" style={{ marginTop: '14px' }}>
                <span className="pre">›</span>editing src/parse.ts
              </div>
              <div className="mc-line mc-add">
                <span className="pre">+</span>if (arr.length === 0) return [];
              </div>
              <div className="mc-line mc-del">
                <span className="pre">−</span>return arr.map(parse);
              </div>
              <div className="mc-line mc-add">
                <span className="pre">+</span>return arr.length ? arr.map(parse) : [];
              </div>
              <div className="mc-line mc-stream" style={{ marginTop: '8px' }}>
                running tests…
              </div>
            </div>
            <div className="pane-foot">always-on · your machine</div>
          </div>
        </div>
      </div>
    </header>
  );
}

/* ============ How it works (loop + providers) ============ */
function HowItWorks() {
  return (
    <section id="how-it-works">
      <div className="wrap">
        <div className="eyebrow">How it works</div>
        <h2>Async, not chat. A session is a task.</h2>
        <div className="loop">
          <div className="loop-step">
            <div className="n">01 — CREATE</div>
            <h3>Delegate from your phone</h3>
            <p>Prompt, pick provider + model. The session starts on your Mac.</p>
          </div>
          <div className="loop-step">
            <div className="n">02 — RUN</div>
            <h3>Agent works while you're away</h3>
            <p>Runs in-process, streams events, survives restarts. You don't have to watch.</p>
          </div>
          <div className="loop-step">
            <div className="n">03 — STEER</div>
            <h3>Redirect mid-task</h3>
            <p>Send a follow-up. Pause, archive, restore — a session FSM guards every transition.</p>
          </div>
        </div>

        <div className="sub-eyebrow" id="providers">
          Powered by any agent SDK
        </div>
        <div className="providers">
          <ProviderCard
            logo={<AnthropicLogo className="prov-logo" />}
            name="Claude"
            flagship="claude-sonnet-4"
            models={['claude-opus-4', 'claude-haiku']}
            tag="via Pi provider"
          />
          <ProviderCard
            logo={<OpenAILogo className="prov-logo" />}
            name="GPT"
            flagship="gpt-5.5"
            models={['gpt-5.4 thinking', 'o3 · o4-mini']}
            tag="via Pi provider"
          />
          <ProviderCard
            logo={<GeminiLogo className="prov-logo" />}
            name="Gemini"
            flagship="gemini-3.1-pro"
            models={['gemini-3.1-flash', 'gemini-3.0-pro']}
            tag="via Pi provider"
          />
          <ProviderCard
            logo={<CursorLogo className="prov-logo" />}
            name="Cursor"
            flagship="composer-2.5"
            models={['composer-2', 'gpt · claude']}
            tag="via Cursor provider"
          />

          {/* extensible — full width row */}
          <div className="prov-ext">
            <div className="ext-copy">
              <span className="ic">+</span>
              <span className="txt">
                <b>Your SDK.</b> Implement <span className="mono">AgentProvider</span>, register it.
                Per-session provider + model selection works uniformly.
              </span>
            </div>
            <a href={`${REPO_URL}/blob/main/apps/server/src/agents/agents.types.ts`}>
              Read the contract →
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProviderCard({
  logo,
  name,
  flagship,
  models,
  tag,
}: {
  logo: React.ReactNode;
  name: string;
  flagship: string;
  models: string[];
  tag: string;
}) {
  return (
    <div className="prov">
      <div className="prov-head">
        {logo}
        <span className="name">{name}</span>
      </div>
      <div className="flagship">{flagship}</div>
      <div className="models">{models.join('\n')}</div>
      <div className="tag">{tag}</div>
    </div>
  );
}

/* ============ Self-hosted ============ */
function SelfHosted() {
  return (
    <section id="selfhosted">
      <div className="wrap">
        <div className="eyebrow">Your data stays yours</div>
        <h2>Nothing leaves your tailnet.</h2>
        <div className="pillars">
          <div className="pillar">
            <h3>Local-first</h3>
            <p>Sessions and event log in SQLite on your machine.</p>
          </div>
          <div className="pillar">
            <h3>Tailscale HTTPS</h3>
            <p>One command. TLS so iPhone PWA install works.</p>
          </div>
          <div className="pillar">
            <h3>Encrypted at rest</h3>
            <p>API keys AES-256-GCM, masked in the UI.</p>
          </div>
          <div className="pillar">
            <h3>Open source</h3>
            <p>MIT. Audit every line. Self-host on your own machine.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============ Mobile PWA ============ */
function MobilePWA() {
  return (
    <section>
      <div className="wrap split">
        <div>
          <div className="eyebrow">Mobile-first PWA</div>
          <h2>Install it on your iPhone home screen.</h2>
          <p className="lede">
            Standalone dark UI, safe-area aware, precached shell. Add to Home Screen from Safari — it
            runs like a native app, driving the agent from anywhere on your tailnet.
          </p>
        </div>
        <div>
          <div className="pwa-frame">
            <div className="pwa-screen">
              <div className="pwa-bar">
                <span>9:41</span>
                <span>●●●</span>
              </div>
              <div className="pwa-title">nuncio</div>
              <div className="pwa-sess">
                <div className="top">
                  <span>New session</span>
                  <span style={{ color: 'var(--fg-faint)' }}>+</span>
                </div>
              </div>
              <div className="pwa-sess">
                <div className="top">
                  <span>Fix empty-array edge</span>
                  <span className="row-status">
                    <span className="sd run" />
                    <span className="live-tag">RUN</span>
                  </span>
                </div>
                <div className="meta">cursor:composer-2</div>
              </div>
              <div className="pwa-sess">
                <div className="top">
                  <span>Refactor auth module</span>
                  <span className="row-status">
                    <span className="sd" />
                    IDLE
                  </span>
                </div>
                <div className="meta">pi:claude-sonnet-4</div>
              </div>
              <div className="pwa-input">
                <span>Prompt or steer…</span>
                <span className="arr">↵</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============ Steer / FSM ============ */
function SteerFsm() {
  return (
    <section>
      <div className="wrap">
        <div className="eyebrow">Long-running, resumable</div>
        <h2>Steer, pause, archive, restore.</h2>
        <div className="fsm">
          <div className="fsm-nodes">
            <span className="fsm-node">CREATED</span>
            <span className="fsm-arrow">→</span>
            <span className="fsm-node run">RUNNING</span>
            <span className="fsm-arrow">→</span>
            <span className="fsm-node">IDLE</span>
            <span className="fsm-arrow">↘</span>
            <span className="fsm-node">PAUSED</span>
            <span className="fsm-arrow">→</span>
            <span className="fsm-node">ARCHIVED</span>
            <span className="fsm-arrow">→</span>
            <span className="fsm-node">restore</span>
            <span className="fsm-arrow">·</span>
            <span className="fsm-node">ERROR</span>
          </div>
          <div className="fsm-legend">
            <span>
              <span style={{ color: 'var(--live)' }}>●</span> RUNNING — agent loop active
            </span>
            <span>● IDLE — awaiting steer</span>
            <span>ARCHIVED — recoverable · restore → IDLE</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============ Real-time + replay ============ */
function RealtimeReplay() {
  return (
    <section>
      <div className="wrap">
        <div className="eyebrow">Real-time + replay</div>
        <h2>Stream live. Replay from any point.</h2>
        <div className="replay">
          <div className="log">
            <div className="log-h">
              <span>event log</span>
              <span className="live-tag">
                <span className="sd" />
                LIVE SSE
              </span>
            </div>
            <div className="log-b">
              <div className="row">
                <span className="seq">014</span>
                <span className="ev">tool_start</span>
                <span>edit_file parse.ts</span>
              </div>
              <div className="row">
                <span className="seq">015</span>
                <span className="ev g">assistant_delta</span>
                <span>Adding guard…</span>
              </div>
              <div className="row">
                <span className="seq">016</span>
                <span className="ev">tool_end</span>
                <span>edit_file ✓</span>
              </div>
              <div className="row">
                <span className="seq">017</span>
                <span className="ev g">assistant_delta</span>
                <span>running tests…</span>
              </div>
            </div>
          </div>
          <div className="log">
            <div className="log-h">
              <span>replay</span>
              <span>?since=0</span>
            </div>
            <div className="log-b">
              <div className="row">
                <span className="seq">001</span>
                <span className="ev">user</span>
                <span>fix empty-array edge case</span>
              </div>
              <div className="row">
                <span className="seq">002</span>
                <span className="ev g">assistant</span>
                <span>on it — editing parse.ts</span>
              </div>
              <div className="row">
                <span className="seq">013</span>
                <span className="ev">steer</span>
                <span>also handle null input</span>
              </div>
              <div className="row">
                <span className="seq">014</span>
                <span className="ev">tool_start</span>
                <span>edit_file parse.ts</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============ Changelog ============ */
function Changelog() {
  return (
    <section id="changelog">
      <div className="wrap">
        <div className="eyebrow">Changelog</div>
        <h2>What's new.</h2>
        <ChangelogSection />
      </div>
    </section>
  );
}

/* ============ FAQ ============ */
function Faq() {
  return (
    <section id="faq">
      <div className="wrap">
        <div className="eyebrow">The practical bits</div>
        <h2>Answered.</h2>
        <div className="faq">
          <details>
            <summary>
              What do I need installed?
              <span className="pm">+</span>
            </summary>
            <div className="a">
              Bun ≥ 1.3 on your Mac. For Pi, log in with the <span className="mono">pi</span> CLI
              first. For Cursor, set <span className="mono">CURSOR_API_KEY</span>. With no
              credentials, a built-in Mock provider still lets the UI work end-to-end.
            </div>
          </details>
          <details>
            <summary>
              Does my code leave my machine?
              <span className="pm">+</span>
            </summary>
            <div className="a">
              Prompts and file snippets go to the provider you pick (Pi or Cursor) under your own
              credentials. Nuncio adds no middleman — nothing is uploaded to a "Nuncio cloud."
            </div>
          </details>
          <details>
            <summary>
              Is there a bill?
              <span className="pm">+</span>
            </summary>
            <div className="a">
              No. MIT-licensed and self-hosted. You only pay for the AI provider subscriptions or API
              keys you already use. No Nuncio account, no pricing tier.
            </div>
          </details>
          <details>
            <summary>
              How do I reach it from my phone?
              <span className="pm">+</span>
            </summary>
            <div className="a">
              Run <span className="mono">tailscale serve --bg 5173</span> after building. Open the
              Tailscale URL in Safari on your iPhone → Share → Add to Home Screen. TLS terminates at
              Tailscale, so the PWA install works.
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}

/* ============ Final CTA ============ */
function FinalCta() {
  return (
    <section className="cta-final">
      <div className="wrap">
        <h2>Run your own Devin. From your phone.</h2>
        <div style={{ marginTop: '26px' }}>
          <a className="btn btn-primary btn-mono" href={REPO_URL}>
            Star on GitHub →
          </a>
        </div>
      </div>
    </section>
  );
}

/* ============ Footer ============ */
function Footer() {
  return (
    <footer className="footer">
      <div className="wrap foot">
        <div className="meta">nuncio · MIT · © oscarlehuu · runs on Bun</div>
        <div className="foot-links">
          <a href={REPO_URL}>GitHub</a>
          <a href={`${REPO_URL}/blob/main/CHANGELOG.md`}>CHANGELOG</a>
          <a href={`${REPO_URL}/blob/main/docs/system-architecture.md`}>Docs</a>
          <a href={`${REPO_URL}/blob/main/SECURITY.md`}>Security</a>
        </div>
      </div>
    </footer>
  );
}
