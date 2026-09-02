import * as React from 'react';

import { cn } from '@/lib/utils';

interface DashboardPageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function DashboardPageHeader({ title, description, actions, className }: DashboardPageHeaderProps) {
  return (
    <div className={cn('mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
