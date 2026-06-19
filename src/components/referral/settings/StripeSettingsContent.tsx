import { Card, CardContent } from "@/components/ui/card";

interface StripeSettingsContentProps {
    projectId?: string;
}

export const StripeSettingsContent = ({ projectId }: StripeSettingsContentProps) => {
    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-foreground mb-1">Stripe Settings</h2>
                <p className="text-sm text-muted-foreground">Manage your Stripe integration settings.</p>
            </div>
            <Card>
                <CardContent className="p-6">
                    <p className="text-sm text-muted-foreground">Stripe configuration coming soon...</p>
                </CardContent>
            </Card>
        </div>
    );
};
