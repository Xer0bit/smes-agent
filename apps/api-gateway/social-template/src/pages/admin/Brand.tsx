import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { invokeFn, uploadFile, getFileDataUrl } from "@/lib/tenant";
import { StoredImage } from "@/hooks/useFileUrl";
import { useClientContext } from "@/hooks/useClientContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { Upload, Download, Trash2, Image, FileText, Mail, RefreshCw, Plus, Package } from "lucide-react";
import { format } from "date-fns";

interface BrandAsset {
  id: string;
  client_id: string;
  asset_type: string;
  file_id: string;
  file_name: string;
  description: string | null;
  revision: number;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

const FIXED_ASSET_TYPES = [
  { key: "logo_white", label: "Logo (White Background)", icon: Image, accept: "image/*" },
  { key: "logo_black", label: "Logo (Black Background)", icon: Image, accept: "image/*" },
  { key: "social_banner", label: "Social Media Banner", icon: Image, accept: "image/*" },
  { key: "email_signature", label: "Email Signature", icon: Mail, accept: "image/*,text/html" },
  { key: "visual_identity", label: "Visual Identity PDF", icon: FileText, accept: ".pdf" },
];

export default function Brand() {
  const { clientId } = useClientContext();
  const queryClient = useQueryClient();
  const [otherDialogOpen, setOtherDialogOpen] = useState(false);
  const [otherDescription, setOtherDescription] = useState("");
  const [otherFile, setOtherFile] = useState<File | null>(null);

  const { data: assets = [] } = useQuery({
    queryKey: ["brand-assets", clientId],
    queryFn: () => invokeFn<BrandAsset[]>("brand-assets", { action: "list", clientId }),
    enabled: !!clientId,
  });

  const fixedAssets = assets.filter((a) => FIXED_ASSET_TYPES.some((t) => t.key === a.asset_type));
  const otherAssets = assets.filter((a) => a.asset_type === "other");

  const uploadMutation = useMutation({
    mutationFn: async ({ file, assetType, description }: { file: File; assetType: string; description?: string }) => {
      if (!clientId) throw new Error("Not ready");
      const uploaded = await uploadFile(file, clientId);
      await invokeFn("brand-assets", {
        action: "save", clientId, assetType, fileId: uploaded.id, fileName: file.name, description,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brand-assets", clientId] });
      toast.success("Asset uploaded successfully");
      setOtherDialogOpen(false);
      setOtherDescription("");
      setOtherFile(null);
    },
    onError: (err: any) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (asset: BrandAsset) => invokeFn("brand-assets", { action: "delete", clientId, id: asset.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brand-assets", clientId] });
      toast.success("Asset deleted");
    },
    onError: (err: any) => toast.error(err.message),
  });

  const downloadAsset = async (asset: BrandAsset) => {
    try {
      const dataUrl = await getFileDataUrl(asset.file_id);
      const a = document.createElement("a");
      a.href = dataUrl; a.download = asset.file_name; a.click();
    } catch {
      toast.error("Could not download this file");
    }
  };

  const handleFileSelect = (assetType: string, accept: string) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) uploadMutation.mutate({ file, assetType });
    };
    input.click();
  };

  const handleAddOther = () => {
    if (!otherFile || !otherDescription.trim()) {
      toast.error("Please provide a file and description");
      return;
    }
    uploadMutation.mutate({ file: otherFile, assetType: "other", description: otherDescription.trim() });
  };

  if (!clientId) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground font-body">
        Please select a client to manage brand assets.
      </div>
    );
  }

  const isImageFile = (fileName: string) => /\.(jpg|jpeg|png|gif|svg|webp)$/i.test(fileName);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-display font-bold text-foreground">Brand Assets</h2>
        <p className="text-muted-foreground font-body text-sm mt-1">
          Manage logos, banners, email signatures, and visual identity files.
        </p>
      </div>

      {/* Fixed asset types */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {FIXED_ASSET_TYPES.map((type) => {
          const asset = fixedAssets.find((a) => a.asset_type === type.key);
          const Icon = type.icon;

          return (
            <Card key={type.key}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-body flex items-center gap-2">
                  <Icon className="h-4 w-4 text-primary" />
                  {type.label}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {asset ? (
                  <>
                    {type.key !== "visual_identity" ? (
                      <div
                        className={`rounded-lg border overflow-hidden flex items-center justify-center h-32 ${
                          type.key === "logo_black" ? "bg-foreground" : "bg-background"
                        }`}
                      >
                        <StoredImage fileId={asset.file_id} alt={type.label} className="max-h-full max-w-full object-contain p-2" />
                      </div>
                    ) : (
                      <div className="rounded-lg border bg-muted/50 flex items-center justify-center h-32">
                        <FileText className="h-10 w-10 text-muted-foreground" />
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground font-body space-y-0.5">
                      <p className="truncate">{asset.file_name}</p>
                      <p className="flex items-center gap-1">
                        <RefreshCw className="h-3 w-3" />
                        Rev {asset.revision} · {format(new Date(asset.updated_at), "MMM d, yyyy")}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className="flex-1" onClick={() => downloadAsset(asset)}>
                        <Download className="h-3 w-3 mr-1" /> Download
                      </Button>
                      <Button size="sm" variant="outline" className="flex-1" onClick={() => handleFileSelect(type.key, type.accept)} disabled={uploadMutation.isPending}>
                        <Upload className="h-3 w-3 mr-1" /> Replace
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => deleteMutation.mutate(asset)} disabled={deleteMutation.isPending}>
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    </div>
                  </>
                ) : (
                  <button
                    onClick={() => handleFileSelect(type.key, type.accept)}
                    disabled={uploadMutation.isPending}
                    className="w-full h-32 rounded-lg border-2 border-dashed border-muted-foreground/30 hover:border-primary/50 transition-colors flex flex-col items-center justify-center gap-2 text-muted-foreground hover:text-primary"
                  >
                    <Upload className="h-6 w-6" />
                    <span className="text-xs font-body">Click to upload</span>
                  </button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Others section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-display font-semibold text-foreground flex items-center gap-2">
            <Package className="h-5 w-5 text-primary" />
            Other Assets
          </h3>
          <Button size="sm" onClick={() => setOtherDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add Asset
          </Button>
        </div>

        {otherAssets.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground font-body text-sm">
              No other assets yet. Click "Add Asset" to upload one.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {otherAssets.map((asset) => (
              <Card key={asset.id}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-body flex items-center gap-2">
                    <Package className="h-4 w-4 text-primary" />
                    {asset.description || "Other Asset"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {isImageFile(asset.file_name) ? (
                    <div className="rounded-lg border overflow-hidden flex items-center justify-center h-32 bg-background">
                      <StoredImage fileId={asset.file_id} alt={asset.description || "Asset"} className="max-h-full max-w-full object-contain p-2" />
                    </div>
                  ) : (
                    <div className="rounded-lg border bg-muted/50 flex items-center justify-center h-32">
                      <FileText className="h-10 w-10 text-muted-foreground" />
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground font-body space-y-0.5">
                    <p className="truncate">{asset.file_name}</p>
                    <p>{format(new Date(asset.created_at), "MMM d, yyyy")}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => downloadAsset(asset)}>
                      <Download className="h-3 w-3 mr-1" /> Download
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => deleteMutation.mutate(asset)} disabled={deleteMutation.isPending}>
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Add Other Asset Dialog */}
      <Dialog open={otherDialogOpen} onOpenChange={setOtherDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display">Add Other Asset</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="font-body">Description</Label>
              <Input
                placeholder="e.g. Letterhead template, Business card design"
                value={otherDescription}
                onChange={(e) => setOtherDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label className="font-body">File</Label>
              <Input
                type="file"
                onChange={(e) => setOtherFile(e.target.files?.[0] || null)}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleAddOther} disabled={uploadMutation.isPending || !otherFile || !otherDescription.trim()}>
              <Upload className="h-4 w-4 mr-1" />
              {uploadMutation.isPending ? "Uploading..." : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
