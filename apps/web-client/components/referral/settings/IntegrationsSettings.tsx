import { useSubscription } from "@/contexts/SubscriptionContext";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Code2, CreditCard, Zap } from "lucide-react";
import { HeaderIntegrationsSettings } from "./HeaderIntegrationsSettings";
import { StripeSettingsContent } from "./StripeSettingsContent";
import { ZapierSettingsContent } from "./ZapierSettingsContent";

interface IntegrationsSettingsProps {
  projectId?: string;
}

function RowHeader({ icon, title, description, badge }: { icon: React.ReactNode; title: string; description: string; badge?: string }) {
  return (
    <div className="flex flex-1 items-center gap-3 text-left">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] border border-white/[0.07]">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white/85">{title}</span>
          {badge && <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">{badge}</Badge>}
        </div>
        <p className="text-xs text-white/40 mt-0.5">{description}</p>
      </div>
    </div>
  );
}

function ComingSoonCard({ title, description }: { title: string; description: string }) {
  return (
    <Card className="bg-workspace-surface-recessed border-white/[0.07]">
      <CardContent className="p-4 text-sm text-white/45">{description}</CardContent>
    </Card>
  );
}

export function IntegrationsSettings({ projectId }: IntegrationsSettingsProps) {
  const { hasFeature } = useSubscription();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white/85 mb-1">Integrations</h2>
        <p className="text-sm text-white/45">
          Connect analytics, tracking, payments, and automation to your published site — all in one place.
        </p>
      </div>

      <Accordion type="single" collapsible className="rounded-lg border border-white/[0.07] bg-workspace-surface px-4">
        <AccordionItem value="site-tracking" className="border-white/[0.07]">
          <AccordionTrigger className="hover:no-underline">
            <RowHeader
              icon={<Code2 className="h-4 w-4 text-white/60" />}
              title="Site Tracking &amp; Scripts"
              description="Google Analytics, Tag Manager, Meta Pixel, WhatsApp button, and custom head/body code."
            />
          </AccordionTrigger>
          <AccordionContent>
            <HeaderIntegrationsSettings projectId={projectId} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="stripe" className="border-white/[0.07]">
          <AccordionTrigger className="hover:no-underline">
            <RowHeader
              icon={<CreditCard className="h-4 w-4 text-white/60" />}
              title="Stripe"
              description="Accept payments and manage subscriptions."
              badge={hasFeature('integration_app') ? undefined : 'Paid plan'}
            />
          </AccordionTrigger>
          <AccordionContent>
            <StripeSettingsContent projectId={projectId} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="zapier" className="border-white/[0.07]">
          <AccordionTrigger className="hover:no-underline">
            <RowHeader
              icon={<Zap className="h-4 w-4 text-white/60" />}
              title="Zapier"
              description="Give your project's AI chat access to thousands of Zapier-connected tools."
              badge={hasFeature('integration_app') ? undefined : 'Paid plan'}
            />
          </AccordionTrigger>
          <AccordionContent>
            <ZapierSettingsContent projectId={projectId} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="alipay" className="border-white/[0.07]">
          <AccordionTrigger className="hover:no-underline">
            <RowHeader
              icon={<CreditCard className="h-4 w-4 text-white/30" />}
              title="Alipay"
              description="Accept payments from the Chinese market."
              badge="Coming soon"
            />
          </AccordionTrigger>
          <AccordionContent>
            <ComingSoonCard title="Alipay" description="Alipay integration is not available yet." />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="airwallex" className="border-white/[0.07] last:border-b-0">
          <AccordionTrigger className="hover:no-underline">
            <RowHeader
              icon={<CreditCard className="h-4 w-4 text-white/30" />}
              title="Airwallex"
              description="Multi-currency payments and global payouts."
              badge="Coming soon"
            />
          </AccordionTrigger>
          <AccordionContent>
            <ComingSoonCard title="Airwallex" description="Airwallex integration is not available yet." />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
