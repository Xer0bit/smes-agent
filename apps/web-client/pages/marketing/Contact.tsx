import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import "../../styles/contact.css";

export default function Contact() {
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    // Placeholder: no backend endpoint yet
    setTimeout(() => {
      setSubmitting(false);
      toast.success("Message sent. We'll be in touch within 24 hours.");
      (e.target as HTMLFormElement).reset();
    }, 800);
  };

  return (
    <>
      <section className="smes-contact-hero">
        <div className="smes-site-page-hero__inner smes-site-reveal">
          <h1>Get in touch.</h1>
          <p className="smes-site-page-hero__copy">
            Enterprise inquiries, partnership questions, or just want to learn more. We respond within 24 hours.
          </p>
        </div>
      </section>

      <section className="smes-contact-form-section smes-site-reveal">
        <div className="smes-site-section__inner">
          <div className="smes-contact-form__grid">
            <div className="smes-contact-form__header">
              <h2>Send us a message.</h2>
              <p>Tell us about your business and what you&apos;re trying to build. We&apos;ll point you in the right direction.</p>
            </div>
            <form className="smes-contact-form" onSubmit={handleSubmit}>
              <div className="smes-contact-row">
                <div className="smes-contact-field">
                  <label htmlFor="contact-name">Name</label>
                  <input id="contact-name" name="name" type="text" placeholder="Your name" required />
                </div>
                <div className="smes-contact-field">
                  <label htmlFor="contact-email">Email</label>
                  <input id="contact-email" name="email" type="email" placeholder="you@company.com" required />
                </div>
              </div>
              <div className="smes-contact-row">
                <div className="smes-contact-field">
                  <label htmlFor="contact-company">Company</label>
                  <input id="contact-company" name="company" type="text" placeholder="Company name" />
                </div>
                <div className="smes-contact-field">
                  <label htmlFor="contact-size">Team size</label>
                  <select id="contact-size" name="teamSize" defaultValue="">
                    <option value="" disabled>Select...</option>
                    <option value="1-10">1-10</option>
                    <option value="11-50">11-50</option>
                    <option value="51-200">51-200</option>
                    <option value="200+">200+</option>
                  </select>
                </div>
              </div>
              <div className="smes-contact-field">
                <label htmlFor="contact-message">Message</label>
                <textarea id="contact-message" name="message" placeholder="What are you trying to build?" required />
              </div>
              <button className="smes-site-button smes-site-button--dark" type="submit" disabled={submitting} style={{ alignSelf: "flex-start" }}>
                {submitting ? "Sending..." : "Send message"}
              </button>
            </form>
          </div>
        </div>
      </section>

      <section className="smes-contact-channels smes-site-reveal">
        <div className="smes-site-section__inner">
          <h2>Other ways to reach us.</h2>
          <div className="smes-contact-channels__grid">
            <div className="smes-contact-channel">
              <h3>Email</h3>
              <p><a href="mailto:support@xer0bit.com">support@xer0bit.com</a></p>
            </div>
            <div className="smes-contact-channel">
              <h3>Enterprise sales</h3>
              <p><a href="mailto:sales@xer0bit.com">sales@xer0bit.com</a></p>
            </div>
            <div className="smes-contact-channel">
              <h3>Documentation</h3>
              <p>Guides, API reference, and tutorials coming soon.</p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
