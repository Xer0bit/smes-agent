import { Shield, Lock, Check, ArrowUpRight } from "lucide-react";
import { useLandingContext } from "@/contexts/LandingContext";
import "../../styles/features.css";

const workflow = [
  { number: "01", title: "Describe the outcome", copy: "Tell the agent what the business needs. A launch plan, a sales workflow, a content calendar: the result, not the steps." },
  { number: "02", title: "Review the plan", copy: "The agent returns a structured plan before anything executes. Every decision is visible, every action is named." },
  { number: "03", title: "Approve execution", copy: "Nothing runs without your go-ahead. Approve the plan, adjust the scope, or send it back. You stay in control." },
  { number: "04", title: "Track the work", copy: "Execution happens in one place. See what shipped, what\u2019s in progress, and what needs your attention next." },
];

const capabilities = [
  { title: "Strategy & planning", copy: "Turn business objectives into structured plans, market research, and prioritized next actions. The agent organizes the thinking so you can focus on the decisions.", label: "Direction", large: true },
  { title: "Social & content", copy: "Plan campaigns, draft content, and manage publishing workflows from one prompt.", label: "Reach" },
  { title: "Sales workflows", copy: "Build the sequences and follow-up systems that move customers from interest to action.", label: "Revenue" },
  { title: "Operations", copy: "Connect the work behind the scenes, logistics, scheduling, vendor coordination, so the business keeps moving.", label: "Execution" },
];

const security = [
  { icon: Shield, title: "SOC 2 Type II", copy: "Certified controls for security, availability, and confidentiality." },
  { icon: Lock, title: "End-to-end encryption", copy: "AES-256 at rest, TLS 1.3 in transit. Your data never leaves encrypted." },
  { icon: Check, title: "GDPR compliant", copy: "Data processing agreements, right to deletion, and full audit trails." },
];

const faqs = [
  { question: "What can I ask SMEs Agent to do?", answer: "Start with the business outcome you want. The agent turns that into a structured plan and coordinates the work across strategy, content, sales, and operations." },
  { question: "Do I need technical experience?", answer: "No. The product is built for operators who want working systems without assembling a separate tool for every task." },
  { question: "Can I review work before it runs?", answer: "Yes. Every plan goes through an approval step before execution. You decide what ships." },
  { question: "Is this only for one part of my business?", answer: "No. SMEs Agent handles strategy, social, sales, and the operational work that connects them, all from the same business context." },
  { question: "How do you handle data security?", answer: "We\u2019re SOC 2 Type II certified, use AES-256 encryption at rest and TLS 1.3 in transit, and are fully GDPR compliant. Enterprise customers get dedicated infrastructure and custom data processing agreements." },
  { question: "Can I cancel anytime?", answer: "Yes. All plans are month-to-month with no long-term contracts. You can cancel or downgrade at any time from your account settings." },
];

export default function Features() {
  const { onLaunch } = useLandingContext();

  return (
    <>
      <section className="smes-feat-hero">
        <div className="smes-site-page-hero__inner smes-site-reveal">
          <h1>Everything your business needs. One agent.</h1>
          <p className="smes-site-page-hero__copy">
            From strategy to execution, SMEs Agent coordinates the work across every part of your business.
          </p>
        </div>
      </section>

      <section className="smes-feat-workflow smes-site-reveal">
        <div className="smes-site-section__inner">
          <div className="smes-feat-workflow__header">
            <h2>From one line to real progress.</h2>
          </div>
          <div className="smes-feat-workflow__timeline">
            {workflow.map(({ number, title, copy }) => (
              <div className="smes-feat-workflow__step" key={number}>
                <span className="smes-feat-workflow__number">{number}</span>
                <div className="smes-feat-workflow__content">
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="smes-feat-capabilities smes-site-reveal">
        <div className="smes-site-section__inner">
          <div className="smes-feat-capabilities__header">
            <h2>Every system your business needs. One place.</h2>
          </div>
          <div className="smes-feat-capabilities__grid">
            {capabilities.map(({ title, copy, label, large }) => (
              <article className={`smes-feat-capability${large ? " smes-feat-capability--large" : ""}`} key={title}>
                <span>{label}</span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="smes-feat-security smes-site-reveal">
        <div className="smes-site-section__inner">
          <div className="smes-feat-security__grid">
            <div>
              <h2>Enterprise-grade security. Built in.</h2>
              <p>Your business data deserves more than basic encryption. We&apos;re certified, compliant, and transparent about how we protect your information.</p>
            </div>
            <div className="smes-feat-security__cards">
              {security.map(({ icon: Icon, title, copy }) => (
                <div className="smes-feat-security__card" key={title}>
                  <Icon size={20} />
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="smes-feat-control smes-site-reveal">
        <div className="smes-site-section__inner">
          <div className="smes-feat-control__grid">
            <div>
              <h2>You decide what runs.</h2>
              <p style={{ marginTop: "var(--smes-site-space-5)" }}>The agent moves work forward, but nothing executes without your approval. Clear planning stages and explicit go-ahead steps give you the leverage of automation without losing control of the business.</p>
            </div>
            <div className="smes-feat-control__flow">
              <div className="smes-feat-control__flow-step">
                <span className="smes-feat-control__flow-arrow">01</span>
                <span className="smes-feat-control__flow-label">Plan generated</span>
                <span className="smes-feat-control__flow-status smes-feat-control__flow-status--ready">done</span>
              </div>
              <div className="smes-feat-control__flow-step">
                <span className="smes-feat-control__flow-arrow">02</span>
                <span className="smes-feat-control__flow-label">Scope reviewed</span>
                <span className="smes-feat-control__flow-status smes-feat-control__flow-status--ready">done</span>
              </div>
              <div className="smes-feat-control__flow-step">
                <span className="smes-feat-control__flow-arrow">03</span>
                <span className="smes-feat-control__flow-label">Awaiting approval</span>
                <span className="smes-feat-control__flow-status smes-feat-control__flow-status--waiting">paused</span>
              </div>
              <div className="smes-feat-control__flow-step">
                <span className="smes-feat-control__flow-arrow">04</span>
                <span className="smes-feat-control__flow-label">Execute tasks</span>
                <span className="smes-feat-control__flow-status smes-feat-control__flow-status--ready">queued</span>
              </div>
              <div className="smes-feat-control__flow-step">
                <span className="smes-feat-control__flow-arrow">05</span>
                <span className="smes-feat-control__flow-label">Report &amp; iterate</span>
                <span className="smes-feat-control__flow-status smes-feat-control__flow-status--ready">queued</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="smes-feat-faq smes-site-reveal">
        <div className="smes-site-section__inner">
          <div className="smes-feat-faq__grid">
            <div className="smes-feat-faq__header">
              <h2>Questions, answered.</h2>
            </div>
            <div className="smes-feat-faq__list">
              {faqs.map(({ question, answer }) => (
                <details key={question}>
                  <summary>{question}</summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="smes-feat-cta smes-site-reveal">
        <div className="smes-site-section__inner" style={{ textAlign: "center" }}>
          <h2>Ready to build?</h2>
          <p>Start with the outcome. SMEs Agent handles the rest.</p>
          <div style={{ marginTop: "var(--smes-site-space-8)" }}>
            <button className="smes-site-button smes-site-button--dark" type="button" onClick={onLaunch}>
              Start building <ArrowUpRight aria-hidden="true" size={16} />
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
