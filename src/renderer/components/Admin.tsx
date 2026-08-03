import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { Activity, AlertTriangle, Briefcase, CheckCircle2, Loader2, Power, RotateCcw, Scale, Send, Server, Users } from "lucide-react";
import { toast } from "sonner";

const metricCards = [
  { key: "totalUsers", label: "Users", icon: Users },
  { key: "totalCases", label: "Cases", icon: Briefcase },
  { key: "totalLawyers", label: "Lawyers", icon: Scale },
  { key: "totalOutreach", label: "Outreach records", icon: Send },
] as const;

export default function Admin() {
  const { user } = useAuth();
  const enabled = user?.role === "admin";
  const utils = trpc.useUtils();
  const overview = trpc.adminAnalytics.overview.useQuery(undefined, { enabled });
  const funnel = trpc.adminAnalytics.conversionFunnel.useQuery(undefined, { enabled });
  const usage = trpc.adminAnalytics.usageMetrics.useQuery(undefined, { enabled });
  const topUsers = trpc.adminAnalytics.topUsers.useQuery(undefined, { enabled });
  const diagnostics = trpc.admin.diagnostics.useQuery(undefined, { enabled });
  const emergencyStop = trpc.admin.emergencyStopStatus.useQuery(undefined, { enabled });
  const uncertainDispatches = trpc.admin.uncertainOutreachDispatches.useQuery(undefined, { enabled });
  const [resolution, setResolution] = useState<null | { outreachId: string; outcome: "delivered" | "not_delivered" }>(null);
  const [providerVerified, setProviderVerified] = useState(false);
  const [providerReference, setProviderReference] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");

  const emergencyMutation = trpc.admin.setEmergencyStop.useMutation({
    onSuccess: async (result) => {
      await utils.admin.emergencyStopStatus.invalidate();
      toast.success(result.engaged ? "Outreach emergency stop engaged" : "Outreach emergency stop released");
    },
    onError: (error) => toast.error(error.message),
  });
  const resolveDispatch = trpc.admin.resolveUncertainOutreachDispatch.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        utils.admin.uncertainOutreachDispatches.invalidate(),
        utils.adminAnalytics.overview.invalidate(),
      ]);
      toast.success(result.canRetry ? "Delivery cleared for a controlled retry" : "Delivery recorded without retransmission");
      setResolution(null);
      setProviderVerified(false);
      setProviderReference("");
      setResolutionNote("");
    },
    onError: (error) => toast.error(error.message),
  });

  if (!enabled) {
    return (
      <DashboardLayout>
        <main className="p-6">
          <h1 className="text-2xl font-semibold">Administration</h1>
          <p className="mt-2 text-sm text-muted-foreground">Administrator access is required.</p>
        </main>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <main className="space-y-6 p-4 md:p-6">
        <header>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">Administration</h1>
            <Badge variant="outline">Live database</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Current operating totals and workflow conversion.</p>
        </header>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="System totals">
          {metricCards.map(({ key, label, icon: Icon }) => (
            <Card key={key}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">{label}</CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                {overview.isLoading ? <Skeleton className="h-8 w-16" /> : <p className="text-2xl font-semibold">{overview.data?.[key] ?? 0}</p>}
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          <div>
            <div className="mb-3 flex items-center gap-2">
              <Activity className="h-4 w-4" />
              <h2 className="text-base font-semibold">Case-to-outreach flow</h2>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-muted-foreground">
                  <tr><th className="px-3 py-2">Stage</th><th className="px-3 py-2 text-right">Records</th></tr>
                </thead>
                <tbody>
                  {(["created", "matched", "outreach", "approved"] as const).map((stage) => (
                    <tr key={stage} className="border-t">
                      <td className="px-3 py-2 capitalize">{stage}</td>
                      <td className="px-3 py-2 text-right font-medium">{funnel.data?.[stage] ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h2 className="mb-3 text-base font-semibold">Stored resources</h2>
            <div className="divide-y rounded-md border">
              {(usage.data ?? []).map((item) => (
                <div key={item.metric} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="capitalize text-muted-foreground">{item.metric}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
              {!usage.isLoading && (usage.data?.length ?? 0) === 0 && <p className="p-3 text-sm text-muted-foreground">No usage records available.</p>}
            </div>
          </div>
        </section>

        <section className="space-y-3" aria-label="Operations">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4" />
            <h2 className="text-base font-semibold">Operations</h2>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            <div className="flex min-h-24 items-center justify-between gap-4 rounded-md border p-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">Outreach emergency stop</span>
                  <Badge variant={emergencyStop.data?.engaged ? "destructive" : "outline"}>
                    {emergencyStop.data?.engaged ? "Engaged" : "Released"}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">Controls every outbound outreach delivery.</p>
              </div>
              <Button
                variant={emergencyStop.data?.engaged ? "outline" : "destructive"}
                disabled={emergencyStop.isLoading || emergencyMutation.isPending}
                onClick={() => emergencyMutation.mutate({ engaged: !emergencyStop.data?.engaged })}
              >
                {emergencyMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
                {emergencyStop.data?.engaged ? "Release" : "Stop outreach"}
              </Button>
            </div>

            <div className="min-h-24 rounded-md border p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-medium">Provider configuration</span>
                <Badge variant={diagnostics.data?.db.ready ? "outline" : "destructive"}>
                  Database {diagnostics.data?.db.ready ? "ready" : "unavailable"}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                {(["google", "email", "ai", "s3"] as const).map((provider) => (
                  <Badge key={provider} variant={diagnostics.data?.integrations[provider] ? "default" : "secondary"}>
                    {provider.toUpperCase()} {diagnostics.data?.integrations[provider] ? "configured" : "not configured"}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-3" aria-label="Uncertain outreach deliveries">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            <h2 className="text-base font-semibold">Delivery exceptions</h2>
            <Badge variant={(uncertainDispatches.data?.length ?? 0) > 0 ? "destructive" : "outline"}>
              {uncertainDispatches.data?.length ?? 0}
            </Badge>
          </div>
          {(uncertainDispatches.data ?? []).map((dispatch) => (
            <div key={dispatch.outreachId} className="flex flex-col justify-between gap-3 rounded-md border p-4 md:flex-row md:items-center">
              <div className="min-w-0">
                <p className="font-medium">{dispatch.lawyerName || "Unknown recipient"}</p>
                <p className="text-sm text-muted-foreground">
                  {dispatch.caseType || "Legal case"} · {dispatch.outreachStatus || "Unknown state"}
                  {dispatch.detectedAt ? ` · ${new Date(dispatch.detectedAt).toLocaleString()}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" onClick={() => setResolution({ outreachId: dispatch.outreachId, outcome: "not_delivered" })}>
                  <RotateCcw className="h-4 w-4" />
                  Allow retry
                </Button>
                <Button onClick={() => setResolution({ outreachId: dispatch.outreachId, outcome: "delivered" })}>
                  <CheckCircle2 className="h-4 w-4" />
                  Mark delivered
                </Button>
              </div>
            </div>
          ))}
          {!uncertainDispatches.isLoading && (uncertainDispatches.data?.length ?? 0) === 0 && (
            <div className="rounded-md border px-4 py-3 text-sm text-muted-foreground">No unresolved delivery exceptions.</div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold">Users by case count</h2>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-muted-foreground">
                <tr><th className="px-3 py-2">Account</th><th className="px-3 py-2 text-right">Cases</th></tr>
              </thead>
              <tbody>
                {(topUsers.data ?? []).map((item) => (
                  <tr key={item.userId} className="border-t">
                    <td className="px-3 py-2">{item.email || item.userId}</td>
                    <td className="px-3 py-2 text-right font-medium">{item.cases}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <Dialog open={!!resolution} onOpenChange={(open) => !open && setResolution(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{resolution?.outcome === "delivered" ? "Confirm provider delivery" : "Clear delivery for retry"}</DialogTitle>
              <DialogDescription>
                This decision changes the send-once guard. Verify the provider activity before continuing.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="provider-reference">Provider reference</Label>
                <Input
                  id="provider-reference"
                  value={providerReference}
                  onChange={(event) => setProviderReference(event.target.value)}
                  placeholder="Optional message or activity ID"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="resolution-note">Verification note</Label>
                <Textarea
                  id="resolution-note"
                  value={resolutionNote}
                  onChange={(event) => setResolutionNote(event.target.value)}
                  placeholder="Record what the provider showed"
                />
              </div>
              <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
                <Checkbox checked={providerVerified} onCheckedChange={(value) => setProviderVerified(value === true)} />
                <span>I verified the delivery outcome in the email provider.</span>
              </label>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setResolution(null)}>Cancel</Button>
              <Button
                variant={resolution?.outcome === "not_delivered" ? "outline" : "default"}
                disabled={!providerVerified || resolutionNote.trim().length < 10 || resolveDispatch.isPending}
                onClick={() => resolution && resolveDispatch.mutate({
                  outreachId: resolution.outreachId,
                  outcome: resolution.outcome,
                  providerVerified: true,
                  providerReference: providerReference.trim() || undefined,
                  note: resolutionNote.trim(),
                })}
              >
                {resolveDispatch.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Confirm resolution
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>
    </DashboardLayout>
  );
}
