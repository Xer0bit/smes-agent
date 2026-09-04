import { LegalPage } from "@/components/landing/LegalPage";

export default function Privacy() {
  return (
    <LegalPage
      title="Privacy policy"
      updated="September 3, 2026"
      intro="This policy explains what information SMEs Agent collects, how it is used, and the choices you have. It applies to our website and application."
      sections={[
        {
          heading: "What we collect",
          paragraphs: [
            "Account information: your name, email address, and authentication identifiers when you create an account.",
            "Workspace content: the plans, prompts, projects, and business data you create or connect while using the product.",
            "Usage data: product interactions, agent run logs, and diagnostic information needed to operate and secure the service.",
          ],
        },
        {
          heading: "How we use your data",
          bullets: [
            "To provide, operate, and improve the service.",
            "To execute agent runs that you review and approve.",
            "To handle billing, provide support, and communicate service updates.",
            "To detect abuse, prevent fraud, and maintain security.",
          ],
        },
        {
          heading: "AI processing",
          paragraphs: [
            "To execute agent runs, task content is sent to our AI model providers. Providers process this data solely to fulfill your requests, under their own data processing terms. We do not sell your data, and we do not use your business content to advertise to you.",
          ],
        },
        {
          heading: "Data sharing",
          bullets: [
            "AI model providers, strictly to execute the runs you approve.",
            "Infrastructure and payment providers needed to operate the service.",
            "Authorities, where disclosure is required by law.",
          ],
        },
        {
          heading: "Retention and deletion",
          paragraphs: [
            "We keep your data while your account is active. When you delete your account, workspace data is deleted, with residual copies removed from backups within 30 days.",
          ],
        },
        {
          heading: "Security",
          paragraphs: [
            "Data is encrypted in transit (TLS 1.3) and at rest (AES-256). Access to production systems is restricted, logged, and audited.",
          ],
        },
        {
          heading: "Your rights",
          paragraphs: [
            "Depending on your location, you may have rights to access, correct, export, or delete your personal data, and to object to or restrict certain processing. To exercise any of these rights, contact us using the details below.",
          ],
        },
        {
          heading: "Contact",
          paragraphs: ["Questions about this policy or your data? Email support@xer0bit.com."],
        },
      ]}
    />
  );
}
