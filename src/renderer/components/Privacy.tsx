import { useEffect, useRef, useState } from "react";
import { Download, Shield, Trash2 } from "lucide-react";
import { toast } from "sonner";
import DashboardLayout from "@/components/DashboardLayout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { PageHeading, QueryNotice } from "@/components/WorkspaceUi";
import { Link } from "wouter";
import { includeConnectedDesktopScanner, eraseConnectedDesktopScanner } from "@/lib/scannerPrivacy";

export default function Privacy() {
  const [confirmEmail, setConfirmEmail] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const ownerId = me.data?.id ?? null;
  const ownerRef = useRef<string | null>(ownerId);
  const mountedRef = useRef(true);
  ownerRef.current = ownerId;
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const consentInput = ownerId ? { expectedUserId: ownerId } : undefined;
  const consent = trpc.gdpr.getConsent.useQuery(consentInput, {
    enabled: Boolean(ownerId),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const activeConsent = consent.data?.ownerId === ownerId ? consent.data : undefined;
  const exportData = trpc.gdpr.exportData.useMutation();
  const deleteData = trpc.gdpr.deleteData.useMutation();
  const updateConsent = trpc.gdpr.updateConsent.useMutation();

  const downloadExport = async () => {
    try {
      const result = await includeConnectedDesktopScanner(await exportData.mutateAsync());
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
      await eraseConnectedDesktopScanner(me.data.id);
      const result = await deleteData.mutateAsync({ confirm: true, expectedUserId: me.data.id });
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

  const setAnalyticsConsent = async (value: boolean) => {
    const expectedUserId = ownerRef.current;
    if (!expectedUserId) {
      toast.error("Sign in again before changing this preference");
      return;
    }
    try {
      const updated = await updateConsent.mutateAsync({ analytics: value, expectedUserId });
      if (!mountedRef.current || ownerRef.current !== updated.ownerId) return;
      utils.gdpr.getConsent.setData({ expectedUserId: updated.ownerId }, {
        ownerId: updated.ownerId,
        dataProcessing: true,
        analytics: updated.analytics,
      });
      toast.success("Privacy preference updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Preference update failed");
    }
  };

  return (
    <DashboardLayout>
      <section className="space-y-6">
        <PageHeading title="Privacy and data" actions={<Button variant="outline" asChild><Link href="/settings?section=security">Back to settings</Link></Button>} />
        {me.error && <QueryNotice error={me.error} retry={me.refetch} />}

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
                    <Button variant="outline" disabled={deleteData.isPending} onClick={() => { setShowDelete(false); setConfirmEmail(""); }}>Cancel</Button>
                    <Button variant="destructive" onClick={removeAccount} disabled={deleteData.isPending || !me.data?.email || confirmEmail.trim().toLowerCase() !== me.data.email.toLowerCase()}>{deleteData.isPending ? "Deleting..." : "Erase account"}</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <section>
          <div className="mb-3 flex items-center gap-2"><Shield className="h-4 w-4" /><h2 className="text-base font-semibold">Processing and privacy choices</h2></div>
          {consent.error && <QueryNotice error={consent.error} retry={consent.refetch} />}
          {(consent.isLoading || (Boolean(ownerId) && !activeConsent)) && <p role="status" className="py-3 text-sm text-muted-foreground">Loading privacy preferences...</p>}
          <div className="divide-y rounded-md border">
            <div className="flex items-center justify-between gap-4 p-4"><div><p className="text-sm font-medium">Service data processing</p><p className="text-xs text-muted-foreground">Required to operate cases, evidence, matching, and account rights.</p></div><span className="text-xs font-medium">Required</span></div>
            <div className="flex items-center justify-between gap-4 p-4"><div><p className="text-sm font-medium">Security and resource integrity</p><p className="text-xs text-muted-foreground">Required audit, session-security, and safe resource-limit records remain active.</p></div><span className="text-xs font-medium">Required</span></div>
            <div className="flex items-center justify-between gap-4 p-4"><div><p className="text-sm font-medium">Usage analytics</p><p className="text-xs text-muted-foreground">Optionally stores local operation types and counts. Turning this off stops new usage-analytics records.</p></div><Switch aria-label="Allow usage analytics" checked={Boolean(activeConsent?.analytics)} onCheckedChange={setAnalyticsConsent} disabled={updateConsent.isPending || !activeConsent || !!consent.error} /></div>
          </div>
        </section>
      </section>
    </DashboardLayout>
  );
}
