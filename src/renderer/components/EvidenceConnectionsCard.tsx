import { useCallback, useRef, useState } from "react";
import { Mail, Cloud, Plus, RefreshCw, Unplug, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { trpc } from "@/lib/trpc";
import { useGoogleOAuthConnection } from "@/hooks/useGoogleOAuthConnection";

type AccountRevision = { id: string; status: string | null; updatedAt: Date | null; connectedAt: Date | null };
const revision = (account: AccountRevision) => JSON.stringify([account.status, account.updatedAt, account.connectedAt]);
const sourceLabel = (sourceType: string) => {
  if (sourceType.toLowerCase() === "gmail") return "Gmail";
  if (["googledrive", "google_drive"].includes(sourceType.toLowerCase())) return "Google Drive";
  return sourceType;
};

export default function EvidenceConnectionsCard() {
  const utils = trpc.useUtils();
  const accounts = trpc.providerConnections.list.useQuery(
    { provider: "gmail" },
    { refetchOnWindowFocus: true, refetchInterval: 5000 },
  );
  const oauth = trpc.providerConnections.begin.useMutation();
  const revoke = trpc.providerConnections.disconnect.useMutation();
  const baseline = useRef(new Map<string, string>());
  const [removing, setRemoving] = useState<string | null>(null);
  const disconnectImpact = trpc.providerConnections.disconnectImpact.useQuery(
    { accountId: removing || "" },
    { enabled: Boolean(removing), retry: false },
  );
  const refreshAll = useCallback(() => {
    void utils.providerConnections.list.invalidate();
  }, [utils]);
  const refreshConnection = useCallback(async () => {
    const result = await accounts.refetch();
    return (result.data ?? []).some((account) => account.provider === "gmail"
      && account.status === "connected" && baseline.current.get(account.id) !== revision(account));
  }, [accounts.refetch]);
  const { connecting, beginConnection, cancelConnection } = useGoogleOAuthConnection({
    // Existing grants must not complete an add-account or reconnect attempt.
    connected: false, refreshConnection, onConnected: refreshAll,
  });
  const connect = async () => {
    try {
      const latest = await accounts.refetch();
      if (latest.error) throw latest.error;
      baseline.current = new Map((latest.data ?? []).map((account) => [account.id, revision(account)]));
      const result = await oauth.mutateAsync({ provider: "gmail" });
      beginConnection(result.authUrl);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Google connection could not be started");
    }
  };
  const disconnect = async (accountId: string) => {
    if (!disconnectImpact.data || disconnectImpact.data.account.id !== accountId) {
      toast.error("Review the current shared Google disconnect impact before confirming");
      return;
    }
    try {
      const result = await revoke.mutateAsync({
        accountId,
        impactRevision: disconnectImpact.data.impactRevision,
        acknowledgeSharedGoogleGrant: true,
        initiatedFrom: "shared_google_grant",
      });
      setRemoving(null);
      refreshAll();
      const providerResult = result.revocationOutcome === "revoked"
        ? "Google confirmed that the shared grant was revoked."
        : result.revocationOutcome === "already_invalid"
          ? "The shared Google grant was already invalid."
          : "No reusable Google credential was stored.";
      toast.success(
        `${providerResult} Gmail and Google Drive were removed from LARO; ${result.scheduledCollectionsUpdated} scheduled collection configuration(s) were updated and collected documents were retained.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not disconnect this account");
      await disconnectImpact.refetch();
    }
  };
  const googleAccounts = (accounts.data ?? []).filter((account) => account.provider === "gmail");
  return (
    <section aria-label="Google accounts" className="space-y-4 border-b pb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Google accounts</h2>
        <Button onClick={() => void connect()} disabled={connecting || oauth.isPending || revoke.isPending}>
          {connecting || oauth.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
          {connecting ? "Waiting for Google..." : "Add Google account"}
        </Button>
      </div>
      {connecting && <Button variant="outline" onClick={cancelConnection}>Cancel connection</Button>}
      {accounts.error ? <Alert variant="destructive"><AlertDescription>
        Accounts could not be loaded. <Button variant="outline" onClick={() => void accounts.refetch()}>Retry</Button>
      </AlertDescription></Alert> : accounts.isLoading ? <p role="status">Loading accounts...</p>
        : googleAccounts.length === 0 ? <p className="text-sm text-muted-foreground">No Google accounts connected</p> : null}
      {googleAccounts.map((account) => (
        <div key={account.id} className="space-y-3 border-b py-3 last:border-0" data-testid="google-account">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h3 className="break-all text-sm font-medium">{account.email}</h3>
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />Gmail</span>
                <span className="inline-flex items-center gap-1"><Cloud className="h-3 w-3" />Google Drive</span>
                <span>{account.status === "connected" ? "Connection saved" : "Reconnect required"}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={connecting || oauth.isPending || revoke.isPending}
                aria-label={`Reconnect ${account.email}`} onClick={() => void connect()}>
                <RefreshCw className="mr-2 h-4 w-4" />Reconnect
              </Button>
              <Button variant="ghost" size="sm" disabled={revoke.isPending || connecting}
                aria-label={`Disconnect ${account.email}`} onClick={() => setRemoving(account.id)}>
                <Unplug className="mr-2 h-4 w-4" />Disconnect
              </Button>
            </div>
          </div>
          {removing === account.id && <Alert><AlertDescription className="space-y-3">
            <div className="space-y-2 break-words">
              <p className="font-medium">Review shared Google disconnect</p>
              <p>Account: {account.email}</p>
              {disconnectImpact.isLoading ? <p role="status">Loading disconnect impact...</p>
                : disconnectImpact.error ? <p role="alert">The disconnect impact could not be loaded. Retry before disconnecting.</p>
                  : disconnectImpact.data ? <>
                    <p>{disconnectImpact.data.credential.willRevoke
                      ? "The shared Google OAuth credential will be revoked and removed."
                      : "No reusable Google credential is stored; the shared Gmail and Drive connection record will be removed."}</p>
                    <ul className="list-disc space-y-1 pl-5">
                      {disconnectImpact.data.capabilities.map((capability) => <li key={capability.id}>{capability.label} will be removed</li>)}
                    </ul>
                    <p>
                      {disconnectImpact.data.scheduledCollections.length} scheduled collection configuration(s) reference this account.
                      Their affected Gmail or Drive selections will be removed.
                    </p>
                    {disconnectImpact.data.scheduledCollections.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs">
                      {disconnectImpact.data.scheduledCollections.map((collection) => <li key={collection.settingsId}>
                        {collection.caseLabel}: {collection.capabilities.map((value) => value === "gmail" ? "Gmail" : "Google Drive").join(" and ")}
                        {collection.enabled ? " (enabled)" : " (disabled)"}
                      </li>)}
                    </ul>}
                    <p>
                      {disconnectImpact.data.localSourceRecords.reduce((total, source) => total + source.count, 0)} local Google source record(s)
                      {disconnectImpact.data.remainingGoogleAccountsAfter === 0
                        ? " will be removed because this is the final saved Google account."
                        : ` will remain for the ${disconnectImpact.data.remainingGoogleAccountsAfter} other Google account(s).`}
                    </p>
                    {disconnectImpact.data.localSourceRecords.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs">
                      {disconnectImpact.data.localSourceRecords.map((source) => <li key={source.sourceType}>
                        {sourceLabel(source.sourceType)}: {source.count} record(s) will {source.willRemove ? "be removed" : "remain"}
                      </li>)}
                    </ul>}
                    <p>Collected documents and other Google accounts stay unchanged.</p>
                  </> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                size="sm"
                disabled={revoke.isPending || !disconnectImpact.data || disconnectImpact.isFetching}
                onClick={() => void disconnect(account.id)}
              >
                {revoke.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Revoke Gmail and Drive
              </Button>
              <Button variant="outline" size="sm" disabled={revoke.isPending} onClick={() => setRemoving(null)}>Cancel</Button>
              {disconnectImpact.error && <Button variant="outline" size="sm" disabled={disconnectImpact.isFetching} onClick={() => void disconnectImpact.refetch()}>Retry impact</Button>}
            </div>
          </AlertDescription></Alert>}
        </div>
      ))}
    </section>
  );
}
