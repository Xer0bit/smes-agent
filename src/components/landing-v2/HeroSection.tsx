import { useState, useEffect } from "react";

const AgentDemo = () => {
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState("");
  const prompt =
    "Launch my ceramic tableware brand in EU + China. Pull assets from Notion.";

  useEffect(() => {
    if (step !== 0) return;
    let i = 0;
    const id = setInterval(() => {
      i++;
      setTyped(prompt.slice(0, i));
      if (i >= prompt.length) {
        clearInterval(id);
        setTimeout(() => setStep(1), 500);
      }
    }, 28);
    return () => clearInterval(id);
  }, [step]);

  useEffect(() => {
    if (step === 0) return;
    const t = setTimeout(
      () => setStep((s) => (s >= 5 ? 5 : s + 1)),
      step === 1 ? 700 : 1100,
    );
    return () => clearTimeout(t);
  }, [step]);

  const reset = () => {
    setStep(0);
    setTyped("");
  };

  const tasks = [
    {
      t: "Scanning Notion workspace",
      detail: "42 product photos · 18 descriptions · brand.md",
      done: step >= 2,
    },
    {
      t: "Generating site architecture",
      detail: "EN store · 中文商城 · product grid · story page",
      done: step >= 3,
    },
    {
      t: "Localizing copy & currency",
      detail: "en-US → zh-CN · USD → CNY · metric units",
      done: step >= 4,
    },
    {
      t: "Publishing to global + China",
      detail: "yourbrand.com · yourbrand.cn · WeChat Mini Program",
      done: step >= 5,
    },
  ];

  return (
    <div className="agent-demo">
      <div className="agent-demo__chrome">
        <div className="agent-demo__dots">
          <span />
          <span />
          <span />
        </div>
        <div className="agent-demo__label">
          <span className="agent-demo__pulse" />
          agent.ecomgear.dev
        </div>
        <button className="agent-demo__replay" onClick={reset}>
          replay
        </button>
      </div>

      <div className="agent-demo__body">
        <div className="agent-demo__you">
          <span className="agent-demo__role">you</span>
          <span className="agent-demo__msg">
            {typed}
            {step === 0 && <span className="agent-demo__caret" />}
          </span>
        </div>

        {step >= 1 && (
          <div className="agent-demo__agent">
            <span className="agent-demo__role agent-demo__role--agent">
              agent
            </span>
            <span className="agent-demo__msg">
              On it. Building a bilingual storefront for both markets.
            </span>
          </div>
        )}

        {step >= 1 && (
          <div className="agent-demo__tasks">
            {tasks.map((task, i) => {
              const active = step === i + 1;
              const done = task.done;
              return (
                <div
                  key={i}
                  className={`agent-task ${done ? "is-done" : ""} ${active ? "is-active" : ""}`}
                >
                  <div className="agent-task__icon">
                    {done ? (
                      <svg width="10" height="10" viewBox="0 0 10 10">
                        <path
                          d="M1.5 5.2L4 7.5L8.5 2.5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          fill="none"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : active ? (
                      <span className="agent-task__spinner" />
                    ) : (
                      <span className="agent-task__pending" />
                    )}
                  </div>
                  <div className="agent-task__text">
                    <div className="agent-task__title">{task.t}</div>
                    <div className="agent-task__detail">{task.detail}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {step >= 5 && (
          <div className="agent-demo__result">
            <div className="agent-demo__result-row">
              <span className="agent-demo__url">→ yourbrand.com</span>
              <span className="agent-demo__status">live · 127ms</span>
            </div>
            <div className="agent-demo__result-row">
              <span className="agent-demo__url">→ yourbrand.cn</span>
              <span className="agent-demo__status">
                live · 94ms · Beijing
              </span>
            </div>
            <div className="agent-demo__result-row">
              <span className="agent-demo__url">→ WeChat Mini Program</span>
              <span className="agent-demo__status">published</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

interface HeroSectionProps {
  onLaunch: () => void;
}

export const HeroSection = ({ onLaunch }: HeroSectionProps) => {
  const copy = {
    h1a: "Hire an Agent,",
    h1b: "Not an Agency.",
    sub: "Ecomgear is the autonomous operator for small businesses going global. One prompt and an agent ships your storefront to the world and to China, at the same time.",
  };

  return (
    <section className="hero hero--default" id="product">
      <div className="hero__grid" />
      <div className="hero__inner">

        <h1 className="hero__title">
          <span className="hero__title-line">{copy.h1a}</span>
          <span className="hero__title-line hero__title-line--accent">
            {copy.h1b}
          </span>
        </h1>
        <p className="hero__sub">{copy.sub}</p>
        <div className="hero__cta">
          <button className="btn btn--primary" onClick={onLaunch}>
            Launch with an agent
            <svg width="14" height="14" viewBox="0 0 14 14">
              <path
                d="M3 7H11M11 7L7 3M11 7L7 11"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <div className="hero__meta">
          <div className="hero__meta-item">
            <span className="hero__meta-num">12k+</span>
            <span className="hero__meta-label">SMEs launched</span>
          </div>
          <div className="hero__meta-divider" />
          <div className="hero__meta-item">
            <span className="hero__meta-num">47</span>
            <span className="hero__meta-label">markets · incl. 中国</span>
          </div>
          <div className="hero__meta-divider" />
          <div className="hero__meta-item">
            <span className="hero__meta-num">~4min</span>
            <span className="hero__meta-label">avg. time to publish</span>
          </div>
        </div>
      </div>
      <div className="hero__demo">
        <AgentDemo />
      </div>
    </section>
  );
};
