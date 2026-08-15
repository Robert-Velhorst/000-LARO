import { useState } from "react";
import { Download, Shield, Trash2 } from "lucide-react";
import { toast } from "sonner";
import DashboardLayout from "@/components/DashboardLayout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";

export default function Privacy() {
  const [confirmEmail, setConfirmEmail] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const me = trpc.auth.me.useQuery();
  const consent = trpc.gdpr.getConsent.useQuery();
  const exportData = trpc.gdpr.exportData.useMutation();
  const deleteData = trpc.gdpr.deleteData.useMutation();
  const updateConsent = trpc.gdpr.updateConsent.useMutation({ onSuccess: () => consent.refetch() });

  const downloadExport = async () => {
    try {
      const result = await exportData.mutateAsync();
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `laro-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success("Data export created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Data export failed");
    }
  };

  const removeAccount = async () => {
    if (!me.data?.email || confirmEmail.trim().toLowerCase() !== me.data.email.toLowerCase()) {
      toast.error("Enter the signed-in email address exactly");
      return;
    }
    try {
      const result = await deleteData.mutateAsync({ confirm: true });
      if (result.erasureStatus === "storage_cleanup_pending") {
        toast.warning("Account records erased. Storage cleanup is still pending and will retry automatically.", {
          duration: 8_000,
        });
        window.setTimeout(() => window.location.assign("/"), 2_500);
        return;
      }
      window.location.assign("/");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Account deletion failed");
    }
  };

  const setConsent = async (field: "marketing" | "analytics", value: boolean) => {
    try {
      await updateConsent.mutateAsync({ [field]: value });
      toast.success("Privacy preference updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Preference update failed");
    }
  };

  return (
    <DashboardLayout>
      <main className="space-y-6 p-4 md:p-6">
        <header>
          <h1 className="text-2xl font-semibold">Privacy and data</h1>
          <p className="mt-1 text-sm text-muted-foreground">Export account data, control optional processing, or erase the account.</p>
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Download className="h-4 w-4" />Data export</CardTitle></CardHeader>
            <CardContent>
              <p className="mb-4 text-sm text-muted-foreground">Creates a JSON package of records owned by the signed-in account.</p>
              <Button onClick={downloadExport} disabled={exportData.isPending}>{exportData.isPending ? "Preparing..." : "Export data"}</Button>
            </CardContent>
          </Card>

          <Card className="border-destructive/50">
            <CardHeader><CardTitle className="flex items-center gap-2 text-base text-destructive"><Trash2 className="h-4 w-4" />Erase account</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Alert variant="destructive"><AlertDescription>The live account and its owned records are erased immediately. Recovery backups may retain prior copies until the configured retention period expires (30 days by default).</AlertDescription></Alert>
              {!showDelete ? (
                <Button variant="destructive" onClick={() => setShowDelete(true)}>Start account deletion</Button>
              ) : (
                <div className="space-y-3">
                  <Input aria-label="Confirm signed-in email" type="email" value={confirmEmail} onChange={(event) => setConfirmEmail(event.target.value)} placeholder={me.data?.email || "Signed-in email"} autoComplete="email" />
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => { setShowDelete(false); setConfirmEmail(""); }}>Cancel</Button>
                    <Button variant="destructive" onClick={removeAccount} disabled={deleteData.isPending}>{deleteData.isPending ? "Deleting..." : "Erase account"}</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <section>
          <div className="mb-3 flex items-center gap-2"><Shield className="h-4 w-4" /><h2 className="text-base font-semibold">Optional processing</h2></div>
          <div className="divide-y rounded-md border">
            <div className="flex items-center justify-between gap-4 p-4"><div><p className="text-sm font-medium">Service data processing</p><p className="text-xs text-muted-foreground">Required to operate cases, evidence, and matching.</p></div><span className="text-xs font-medium">Required</span></div>
            <div className="flex items-center justify-between gap-4 p-4"><div><p className="text-sm font-medium">Marketing communication</p><p className="text-xs text-muted-foreground">Optional product and service communication.</p></div><Switch aria-label="Allow marketing communication" checked={Boolean(consent.data?.marketing)} onCheckedChange={(value) => setConsent("marketing", value)} disabled={updateConsent.isPending} /></div>
            <div className="flex items-center justify-between gap-4 p-4"><div><p className="text-sm font-medium">Usage analytics</p><p className="text-xs text-muted-foreground">Optional product-usage measurement.</p></div><Switch aria-label="Allow usage analytics" checked={Boolean(consent.data?.analytics)} onCheckedChange={(value) => setConsent("analytics", value)} disabled={updateConsent.isPending} /></div>
          </div>
        </section>
      </main>
    </DashboardLayout>
  );
}
