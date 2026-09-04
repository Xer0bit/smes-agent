import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Upload, X, FileText, AlertCircle, CheckCircle2, Building2, User } from "lucide-react";
import { cn } from "@/lib/utils";

type FilingType = "individual" | "enterprise";
type IdType = "prc_id" | "hk_macau_permit" | "taiwan_permit" | "passport";

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  url?: string;
}

export const ICPFilingForm = () => {
  const [filingType, setFilingType] = useState<FilingType>("enterprise");
  const [currentStep, setCurrentStep] = useState(1);
  const [idType, setIdType] = useState<IdType>("prc_id");
  const [province, setProvince] = useState("");
  const [domains, setDomains] = useState<string[]>([""]);
  const [uploadedFiles, setUploadedFiles] = useState<Record<string, UploadedFile>>({});

  const provinces = [
    "北京 Beijing", "上海 Shanghai", "广东 Guangdong", "浙江 Zhejiang", 
    "江苏 Jiangsu", "湖北 Hubei", "湖南 Hunan", "四川 Sichuan"
  ];

  const steps = [
    { id: 1, title: "Filing Type", icon: Building2 },
    { id: 2, title: "Basic Information", icon: User },
    { id: 3, title: "Domain & Website", icon: FileText },
    { id: 4, title: "Documents", icon: Upload },
    { id: 5, title: "Review & Submit", icon: CheckCircle2 },
  ];

  const addDomain = () => setDomains([...domains, ""]);
  const removeDomain = (index: number) => setDomains(domains.filter((_, i) => i !== index));
  const updateDomain = (index: number, value: string) => {
    const newDomains = [...domains];
    newDomains[index] = value;
    setDomains(newDomains);
  };

  const handleFileUpload = (documentType: string, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setUploadedFiles({
        ...uploadedFiles,
        [documentType]: {
          id: Math.random().toString(),
          name: file.name,
          size: file.size,
        }
      });
    }
  };

  const removeFile = (documentType: string) => {
    const { [documentType]: removed, ...rest } = uploadedFiles;
    setUploadedFiles(rest);
  };

  const renderStep1 = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-xl font-semibold text-white/85 mb-4">Select Filing Type</h3>
        <p className="text-white/45 mb-6">Choose the type of ICP filing based on your entity.</p>
      </div>

      <RadioGroup value={filingType} onValueChange={(value) => setFilingType(value as FilingType)}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div
            onClick={() => setFilingType("enterprise")}
            className={cn(
              "cursor-pointer rounded-lg border-2 p-6 transition-all duration-smooth hover:border-primary/50",
              filingType === "enterprise" ? "border-primary bg-primary/5" : "border-white/[0.07] bg-workspace-surface"
            )}
          >
            <div className="flex items-start gap-4">
              <RadioGroupItem value="enterprise" id="enterprise" className="mt-1" />
              <div className="flex-1">
                <Label htmlFor="enterprise" className="text-lg font-semibold cursor-pointer flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-primary" />
                  Enterprise Filing
                </Label>
                <p className="text-sm text-white/45 mt-2">
                  For registered companies, organizations, or business entities with a business license.
                </p>
              </div>
            </div>
          </div>

          <div
            onClick={() => setFilingType("individual")}
            className={cn(
              "cursor-pointer rounded-lg border-2 p-6 transition-all duration-smooth hover:border-primary/50",
              filingType === "individual" ? "border-primary bg-primary/5" : "border-white/[0.07] bg-workspace-surface"
            )}
          >
            <div className="flex items-start gap-4">
              <RadioGroupItem value="individual" id="individual" className="mt-1" />
              <div className="flex-1">
                <Label htmlFor="individual" className="text-lg font-semibold cursor-pointer flex items-center gap-2">
                  <User className="h-5 w-5 text-primary" />
                  Individual Filing
                </Label>
                <p className="text-sm text-white/45 mt-2">
                  For personal websites or blogs operated by individual citizens.
                </p>
              </div>
            </div>
          </div>
        </div>
      </RadioGroup>

      <div className="bg-white/[0.03] border border-white/[0.07] rounded-lg p-4 flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
        <div className="text-sm text-white/45">
          <p className="font-medium text-white/85 mb-1">Important Requirements:</p>
          <ul className="space-y-1 list-disc list-inside">
            <li>Domains must be real-name verified before filing</li>
            <li>Alibaba Cloud server or filing service code required</li>
            <li>Processing time: 20-30 business days</li>
            <li>All documents must be clear and legible</li>
          </ul>
        </div>
      </div>
    </div>
  );

  const renderStep2 = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-xl font-semibold text-white/85 mb-4">
          {filingType === "enterprise" ? "Enterprise Information" : "Personal Information"}
        </h3>
        <p className="text-white/45 mb-6">Provide accurate information as it appears on official documents.</p>
      </div>

      {filingType === "enterprise" && (
        <Card className="bg-workspace-surface border-white/[0.07]">
          <CardHeader>
            <CardTitle className="text-base">Enterprise Details</CardTitle>
            <CardDescription>Business license information</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="entity-name">Company Name (企业名称) *</Label>
              <Input id="entity-name" placeholder="e.g., 深圳市科技有限公司" className="bg-input border-white/[0.07]" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="business-license">Business License Number (营业执照号码) *</Label>
              <Input id="business-license" placeholder="e.g., 91440300XXXXXXXXXX" className="bg-input border-white/[0.07]" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="license-upload">Business License Scan (营业执照扫描件) *</Label>
              <div className="flex items-center gap-4">
                {uploadedFiles["business-license"] ? (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/30 flex-1">
                    <FileText className="h-4 w-4 text-primary" />
                    <span className="text-sm text-white/85 flex-1 truncate">
                      {uploadedFiles["business-license"].name}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeFile("business-license")}
                      className="h-auto p-1"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <label className="flex-1 cursor-pointer">
                    <div className="border-2 border-dashed border-white/[0.07] rounded-lg p-4 hover:border-primary/50 transition-colors duration-smooth bg-workspace-surface">
                      <div className="flex items-center justify-center gap-2 text-white/45">
                        <Upload className="h-5 w-5" />
                        <span className="text-sm">Click to upload (JPG, PNG, PDF • Max 5MB)</span>
                      </div>
                    </div>
                    <input
                      type="file"
                      id="license-upload"
                      className="hidden"
                      accept=".jpg,.jpeg,.png,.pdf"
                      onChange={(e) => handleFileUpload("business-license", e)}
                    />
                  </label>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <CardTitle className="text-base">Principal Information (负责人信息)</CardTitle>
          <CardDescription>
            {filingType === "enterprise" ? "Legal representative or authorized person" : "Your personal information"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="id-type">ID Type (证件类型) *</Label>
            <Select value={idType} onValueChange={(value) => setIdType(value as IdType)}>
              <SelectTrigger className="bg-input border-white/[0.07]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-white/[0.07]">
                <SelectItem value="prc_id">PRC ID Card (中国大陆身份证)</SelectItem>
                <SelectItem value="hk_macau_permit">HK/Macau Permit (港澳居民来往内地通行证)</SelectItem>
                <SelectItem value="taiwan_permit">Taiwan Permit (台湾居民来往大陆通行证)</SelectItem>
                <SelectItem value="passport">Passport (护照)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="id-number">ID Number (证件号码) *</Label>
              <Input id="id-number" placeholder="e.g., 440XXXXXXXXXXXXXXX" className="bg-input border-white/[0.07]" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="full-name">Full Name (姓名) *</Label>
              <Input id="full-name" placeholder="e.g., 张三" className="bg-input border-white/[0.07]" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="phone">Phone Number (手机号码) *</Label>
              <Input id="phone" type="tel" placeholder="e.g., 138XXXXXXXX" className="bg-input border-white/[0.07]" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email Address (电子邮箱) *</Label>
              <Input id="email" type="email" placeholder="e.g., example@email.com" className="bg-input border-white/[0.07]" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>ID Front Photo (证件正面照) *</Label>
              {uploadedFiles["id-front"] ? (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/30">
                  <FileText className="h-4 w-4 text-primary" />
                  <span className="text-sm text-white/85 flex-1 truncate">
                    {uploadedFiles["id-front"].name}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => removeFile("id-front")} className="h-auto p-1">
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <label className="cursor-pointer block">
                  <div className="border-2 border-dashed border-white/[0.07] rounded-lg p-4 hover:border-primary/50 transition-colors duration-smooth bg-workspace-surface">
                    <div className="flex items-center justify-center gap-2 text-white/45">
                      <Upload className="h-4 w-4" />
                      <span className="text-xs">Upload</span>
                    </div>
                  </div>
                  <input
                    type="file"
                    className="hidden"
                    accept=".jpg,.jpeg,.png"
                    onChange={(e) => handleFileUpload("id-front", e)}
                  />
                </label>
              )}
            </div>

            <div className="space-y-2">
              <Label>ID Back Photo (证件背面照) *</Label>
              {uploadedFiles["id-back"] ? (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/30">
                  <FileText className="h-4 w-4 text-primary" />
                  <span className="text-sm text-white/85 flex-1 truncate">
                    {uploadedFiles["id-back"].name}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => removeFile("id-back")} className="h-auto p-1">
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <label className="cursor-pointer block">
                  <div className="border-2 border-dashed border-white/[0.07] rounded-lg p-4 hover:border-primary/50 transition-colors duration-smooth bg-workspace-surface">
                    <div className="flex items-center justify-center gap-2 text-white/45">
                      <Upload className="h-4 w-4" />
                      <span className="text-xs">Upload</span>
                    </div>
                  </div>
                  <input
                    type="file"
                    className="hidden"
                    accept=".jpg,.jpeg,.png"
                    onChange={(e) => handleFileUpload("id-back", e)}
                  />
                </label>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );

  const renderStep3 = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-xl font-semibold text-white/85 mb-4">Domain & Website Information</h3>
        <p className="text-white/45 mb-6">Configure your domain and website details for ICP filing.</p>
      </div>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <CardTitle className="text-base">Province Selection</CardTitle>
          <CardDescription>Choose the province where your server is located</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="province">Filing Province (备案省份) *</Label>
            <Select value={province} onValueChange={setProvince}>
              <SelectTrigger className="bg-input border-white/[0.07]">
                <SelectValue placeholder="Select province" />
              </SelectTrigger>
              <SelectContent className="bg-popover border-white/[0.07]">
                {provinces.map((prov) => (
                  <SelectItem key={prov} value={prov}>{prov}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <CardTitle className="text-base">Domain List</CardTitle>
          <CardDescription>Add all domains that need ICP filing (must be real-name verified)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {domains.map((domain, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={domain}
                onChange={(e) => updateDomain(index, e.target.value)}
                placeholder="e.g., example.com"
                className="flex-1 bg-input border-white/[0.07]"
              />
              {domains.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeDomain(index)}
                  className="text-destructive hover:text-destructive"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
          <Button
            variant="outline"
            onClick={addDomain}
            className="w-full border-dashed border-primary/50 text-primary hover:bg-primary/5"
          >
            + Add Domain
          </Button>
        </CardContent>
      </Card>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <CardTitle className="text-base">Website Information</CardTitle>
          <CardDescription>Details about your website content and purpose</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="website-name">Website Name (网站名称) *</Label>
            <Input
              id="website-name"
              placeholder="e.g., SMEsAgent Technology Platform"
              maxLength={50}
              className="bg-input border-white/[0.07]"
            />
            <p className="text-xs text-white/45">Must align with business scope (max 50 characters)</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="website-desc">Website Description (网站简介) *</Label>
            <Textarea
              id="website-desc"
              placeholder="Describe your website's purpose, content type, and target audience..."
              maxLength={500}
              rows={4}
              className="bg-input border-white/[0.07] resize-none"
            />
            <p className="text-xs text-white/45">Max 500 characters</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );

  const renderStep4 = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-xl font-semibold text-white/85 mb-4">Additional Documents</h3>
        <p className="text-white/45 mb-6">Upload required documents based on your filing province.</p>
      </div>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <CardTitle className="text-base">Required Documents</CardTitle>
          <CardDescription>Province-specific document requirements</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Website Construction Plan (网站建设方案书)</Label>
              <Badge variant="secondary">Required for Guangdong</Badge>
            </div>
            {uploadedFiles["construction-plan"] ? (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/30">
                <FileText className="h-4 w-4 text-primary" />
                <span className="text-sm text-white/85 flex-1 truncate">
                  {uploadedFiles["construction-plan"].name}
                </span>
                <Button variant="ghost" size="sm" onClick={() => removeFile("construction-plan")} className="h-auto p-1">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <label className="cursor-pointer block">
                <div className="border-2 border-dashed border-white/[0.07] rounded-lg p-6 hover:border-primary/50 transition-colors duration-smooth bg-workspace-surface">
                  <div className="flex flex-col items-center justify-center gap-2 text-white/45">
                    <Upload className="h-6 w-6" />
                    <span className="text-sm">Click to upload (DOC, DOCX, PDF • Max 10MB)</span>
                    <Button variant="link" className="text-xs text-primary p-0 h-auto">
                      Download Template
                    </Button>
                  </div>
                </div>
                <input
                  type="file"
                  className="hidden"
                  accept=".doc,.docx,.pdf"
                  onChange={(e) => handleFileUpload("construction-plan", e)}
                />
              </label>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Hand-held ID Photo (手持证件照)</Label>
              <Badge variant="outline">Required by some provinces</Badge>
            </div>
            {uploadedFiles["handheld-photo"] ? (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/30">
                <FileText className="h-4 w-4 text-primary" />
                <span className="text-sm text-white/85 flex-1 truncate">
                  {uploadedFiles["handheld-photo"].name}
                </span>
                <Button variant="ghost" size="sm" onClick={() => removeFile("handheld-photo")} className="h-auto p-1">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <label className="cursor-pointer block">
                <div className="border-2 border-dashed border-white/[0.07] rounded-lg p-6 hover:border-primary/50 transition-colors duration-smooth bg-workspace-surface">
                  <div className="flex flex-col items-center justify-center gap-2 text-white/45">
                    <Upload className="h-6 w-6" />
                    <span className="text-sm">Click to upload (JPG, PNG • Max 5MB)</span>
                  </div>
                </div>
                <input
                  type="file"
                  className="hidden"
                  accept=".jpg,.jpeg,.png"
                  onChange={(e) => handleFileUpload("handheld-photo", e)}
                />
              </label>
            )}
          </div>

          <div className="space-y-2">
            <Label>Commitment Letter (承诺书)</Label>
            {uploadedFiles["commitment-letter"] ? (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/30">
                <FileText className="h-4 w-4 text-primary" />
                <span className="text-sm text-white/85 flex-1 truncate">
                  {uploadedFiles["commitment-letter"].name}
                </span>
                <Button variant="ghost" size="sm" onClick={() => removeFile("commitment-letter")} className="h-auto p-1">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <label className="cursor-pointer block">
                <div className="border-2 border-dashed border-white/[0.07] rounded-lg p-6 hover:border-primary/50 transition-colors duration-smooth bg-workspace-surface">
                  <div className="flex flex-col items-center justify-center gap-2 text-white/45">
                    <Upload className="h-6 w-6" />
                    <span className="text-sm">Click to upload (PDF • Max 5MB)</span>
                    <Button variant="link" className="text-xs text-primary p-0 h-auto">
                      Download Template
                    </Button>
                  </div>
                </div>
                <input
                  type="file"
                  className="hidden"
                  accept=".pdf"
                  onChange={(e) => handleFileUpload("commitment-letter", e)}
                />
              </label>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="bg-white/[0.03] border border-white/[0.07] rounded-lg p-4 flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
        <div className="text-sm text-white/45">
          <p className="font-medium text-white/85 mb-1">Document Guidelines:</p>
          <ul className="space-y-1 list-disc list-inside">
            <li>All documents must be clear, legible, and in color</li>
            <li>Scanned copies or high-quality photos are acceptable</li>
            <li>File formats: JPG, PNG for photos; PDF, DOC, DOCX for documents</li>
            <li>Documents must match the information provided in the form</li>
          </ul>
        </div>
      </div>
    </div>
  );

  const renderStep5 = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-xl font-semibold text-white/85 mb-4">Review & Submit</h3>
        <p className="text-white/45 mb-6">Please review your application before submitting.</p>
      </div>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <CardTitle className="text-base">Application Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-white/45 mb-1">Filing Type</p>
              <p className="text-white/85 font-medium capitalize">{filingType}</p>
            </div>
            <div>
              <p className="text-white/45 mb-1">Province</p>
              <p className="text-white/85 font-medium">{province || "Not selected"}</p>
            </div>
            <div>
              <p className="text-white/45 mb-1">Domains</p>
              <p className="text-white/85 font-medium">{domains.filter(d => d).length} domain(s)</p>
            </div>
            <div>
              <p className="text-white/45 mb-1">Documents Uploaded</p>
              <p className="text-white/85 font-medium">{Object.keys(uploadedFiles).length} file(s)</p>
            </div>
          </div>

          <div className="border-t border-white/[0.07] pt-4">
            <h4 className="font-semibold text-white/85 mb-3">Document Checklist</h4>
            <div className="space-y-2">
              {[
                { key: "id-front", label: "ID Front Photo" },
                { key: "id-back", label: "ID Back Photo" },
                ...(filingType === "enterprise" ? [{ key: "business-license", label: "Business License" }] : []),
                { key: "construction-plan", label: "Construction Plan" },
              ].map((doc) => (
                <div key={doc.key} className="flex items-center justify-between py-2 px-3 rounded-lg bg-white/[0.03]">
                  <span className="text-sm text-white/85">{doc.label}</span>
                  {uploadedFiles[doc.key] ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-white/45" />
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="bg-primary/10 border border-primary/30 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-white/85 mb-2">Processing Timeline</p>
                <ol className="list-decimal list-inside space-y-1 text-white/45">
                  <li>Alibaba Cloud Initial Review: 1-2 business days</li>
                  <li>Photo Verification (if required): 1-2 business days</li>
                  <li>Provincial Review: 3-20 business days</li>
                  <li>Total estimated time: 20-30 business days</li>
                </ol>
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <input type="checkbox" id="terms" className="mt-1" />
            <Label htmlFor="terms" className="text-sm text-white/45 cursor-pointer">
              I confirm that all information provided is accurate and complete. I understand that providing false information may result in filing rejection or legal consequences.
            </Label>
          </div>
        </CardContent>
      </Card>
    </div>
  );

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-white/85 mb-2">.cn ICP Filing Application</h2>
        <p className="text-white/45">
          Complete the ICP (Internet Content Provider) filing required for hosting websites in mainland China.
        </p>
      </div>

      {/* Progress Steps */}
      <div className="relative">
        <div className="flex justify-between items-center">
          {steps.map((step, index) => {
            const Icon = step.icon;
            const isActive = currentStep === step.id;
            const isCompleted = currentStep > step.id;
            
            return (
              <div key={step.id} className="flex flex-col items-center flex-1 relative">
                <div
                  className={cn(
                    "w-12 h-12 rounded-full flex items-center justify-center border-2 transition-all duration-smooth relative z-10 bg-workspace-surface",
                    isActive && "border-primary bg-primary/10",
                    isCompleted && "border-primary bg-primary text-primary-foreground",
                    !isActive && !isCompleted && "border-white/[0.07] bg-workspace-surface"
                  )}
                >
                  {isCompleted ? (
                    <CheckCircle2 className="h-6 w-6" />
                  ) : (
                    <Icon className={cn("h-5 w-5", isActive ? "text-primary" : "text-white/45")} />
                  )}
                </div>
                <span
                  className={cn(
                    "text-xs mt-2 text-center font-medium",
                    isActive && "text-primary",
                    !isActive && "text-white/45"
                  )}
                >
                  {step.title}
                </span>
                {index < steps.length - 1 && (
                  <div
                    className={cn(
                      "absolute top-6 left-[50%] w-full h-0.5 -z-0",
                      isCompleted ? "bg-primary" : "bg-border"
                    )}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Form Content */}
      <div className="min-h-[500px]">
        {currentStep === 1 && renderStep1()}
        {currentStep === 2 && renderStep2()}
        {currentStep === 3 && renderStep3()}
        {currentStep === 4 && renderStep4()}
        {currentStep === 5 && renderStep5()}
      </div>

      {/* Navigation Buttons */}
      <div className="flex justify-between pt-6 border-t border-white/[0.07]">
        <Button
          variant="outline"
          onClick={() => setCurrentStep(Math.max(1, currentStep - 1))}
          disabled={currentStep === 1}
          className="border-white/[0.07]"
        >
          Previous
        </Button>
        <div className="flex gap-3">
          <Button variant="ghost" className="text-white/45 hover:text-white/85">
            Save Draft
          </Button>
          {currentStep < 5 ? (
            <Button onClick={() => setCurrentStep(Math.min(5, currentStep + 1))} className="bg-primary hover:bg-primary/90">
              Next Step
            </Button>
          ) : (
            <Button className="bg-secondary hover:bg-secondary/90 text-indigo-400-foreground">
              Submit Application
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
