import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface CloudRegionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: (section: string) => void;
}

export function CloudRegionDialog({ open, onOpenChange, onOpenSettings }: CloudRegionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-slate-900 text-white border-slate-700">
        <DialogHeader>
          <DialogTitle className="text-3xl font-bold">SMEsAgent Cloud</DialogTitle>
          <DialogDescription className="sr-only">
            Review regional cloud application options for China and Hong Kong services.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-8 py-6">
          {/* China Section */}
          <div>
            <h3 className="text-2xl font-bold mb-4">China</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2">
                <span className="text-xl">.cn ICP</span>
                <Button
                  variant="outline"
                  className="border-2 border-blue-500 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300"
                  onClick={() => {
                    onOpenChange(false);
                    onOpenSettings('china-icp');
                  }}
                >
                  APPLY
                </Button>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-xl">Wechat Auth.</span>
                <Button
                  variant="outline"
                  className="border-2 border-blue-500 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300"
                  onClick={() => toast.info('Wechat Auth application coming soon')}
                >
                  APPLY
                </Button>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-xl">QQ Auth.</span>
                <Button
                  variant="outline"
                  className="border-2 border-blue-500 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300"
                  onClick={() => toast.info('QQ Auth application coming soon')}
                >
                  APPLY
                </Button>
              </div>
            </div>
          </div>

          {/* Hong Kong Section */}
          <div>
            <h3 className="text-2xl font-bold mb-4">Hong Kong</h3>
            <div className="flex items-center justify-between py-2">
              <span className="text-xl">iAM Smart</span>
              <Button
                variant="outline"
                className="border-2 border-blue-500 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300"
                onClick={() => toast.info('iAM Smart application coming soon')}
              >
                APPLY
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
