import { useState } from "react";
import { toast } from "sonner";
import { ArrowRight, Sparkles, Mail, Clock, MapPin, MessageSquare } from "lucide-react";

const INFO_CARDS = [
  { icon: Mail, title: "General inquiries", value: "info@ecomgear.dev", href: "mailto:info@ecomgear.dev" },
  { icon: MessageSquare, title: "Sales & Enterprise", value: "info@ecomgear.dev", href: "mailto:info@ecomgear.dev" },
  { icon: Clock, title: "Response time", value: "Within 24 hours", href: undefined },
  { icon: MapPin, title: "Markets", value: "🇨🇳 CN · 🇭🇰 HK · 🇺🇸 US", href: undefined },
];

export default function Contact() {
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    await new Promise((r) => setTimeout(r, 800));
    toast.success("Message sent! We'll respond within 24 hours.");
    event.currentTarget.reset();
    setSubmitting(false);
  };

  return (
    <>
      {/* Hero */}
      <section className="hero">
        <div className="hero__grid" />
        <div className="hero__inner">
          <h1 className="hero__title">
            <span className="hero__title-line">Get in touch</span>
            <span className="hero__title-line hero__title-line--accent">with our team.</span>
          </h1>
          <p className="hero__sub">
            Questions, partnership requests, or just want to say hi  we read every message.
          </p>
        </div>
      </section>

      {/* Content */}
      <section className="contact-body">
        <div className="contact-body__inner">
          {/* Info cards */}
          <div className="contact-info">
            {INFO_CARDS.map(({ icon: Icon, title, value, href }) => (
              <div key={title} className="contact-info__card">
                <div className="contact-info__icon">
                  <Icon size={16} />
                </div>
                <div>
                  <span className="contact-info__label">{title}</span>
                  {href ? (
                    <a href={href} className="contact-info__value contact-info__value--link">{value}</a>
                  ) : (
                    <span className="contact-info__value">{value}</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Form */}
          <div className="contact-form">
            <h2 className="contact-form__title">Send a message</h2>
            <form onSubmit={handleSubmit}>
              <div className="contact-form__row">
                <div className="contact-form__field">
                  <label htmlFor="first-name" className="contact-form__label">First name</label>
                  <input id="first-name" name="first-name" type="text" autoComplete="given-name" required placeholder="Wei" className="contact-form__input" />
                </div>
                <div className="contact-form__field">
                  <label htmlFor="last-name" className="contact-form__label">Last name</label>
                  <input id="last-name" name="last-name" type="text" autoComplete="family-name" required placeholder="Zhang" className="contact-form__input" />
                </div>
              </div>
              <div className="contact-form__field">
                <label htmlFor="email" className="contact-form__label">Work email</label>
                <input id="email" name="email" type="email" autoComplete="email" required placeholder="you@company.com" className="contact-form__input" />
              </div>
              <div className="contact-form__field">
                <label htmlFor="subject" className="contact-form__label">Subject</label>
                <input id="subject" name="subject" type="text" required placeholder="Enterprise plan inquiry" className="contact-form__input" />
              </div>
              <div className="contact-form__field">
                <label htmlFor="message" className="contact-form__label">Message</label>
                <textarea id="message" name="message" rows={5} required placeholder="Tell us about your use case, team size, or what you're building..." className="contact-form__textarea" />
              </div>
              <button type="submit" disabled={submitting} className="btn btn--primary contact-form__submit">
                {submitting ? (
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="contact-form__spinner" />
                    Sending…
                  </span>
                ) : (
                  <>Send message <ArrowRight size={14} /></>
                )}
              </button>
            </form>
          </div>
        </div>
      </section>
    </>
  );
}
