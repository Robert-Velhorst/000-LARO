import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Loader2, Mail, Calendar, Search, CheckCircle2, AlertCircle } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { toast } from 'sonner';

interface EmailSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseId: string;
  onSyncComplete?: () => void;
}

export function EmailSyncDialog({ open, onOpenChange, caseId, onSyncComplete }: EmailSyncDialogProps) {
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [keywords, setKeywords] = useState<string>('');
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Query connected accounts
  const { data: accounts } = trpc.emailAccounts.list.useQuery(undefined, {
    enabled: open,
  });

  // Query sync job status
  const { data: syncJob, refetch: refetchSyncJob } = trpc.emailMessages.getSyncJob.useQuery(
    { jobId: syncJobId! },
    { 
      enabled: !!syncJobId,
      refetchInterval: syncing ? 2000 : false, // Poll every 2 seconds while syncing
    }
  );

  // Mutation
  const syncEmails = trpc.emailMessages.syncEmails.useMutation();

  // Set default date range (last 6 months)
  useEffect(() => {
    if (open && !startDate) {
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      setStartDate(sixMonthsAgo.toISOString().split('T')[0]);
      setEndDate(new Date().toISOString().split('T')[0]);
    }
  }, [open]);

  // Monitor sync job completion
  useEffect(() => {
    if (syncJob) {
      if (syncJob.status === 'completed') {
        setSyncing(false);
        toast.success(`Sync complete! Found ${syncJob.totalMessages} emails.`);
        if (onSyncComplete) {
          onSyncComplete();
        }
      } else if (syncJob.status === 'failed') {
        setSyncing(false);
        toast.error(`Sync failed: ${syncJob.errorMessage || 'Unknown error'}`);
      }
    }
  }, [syncJob]);

  const handleSync = async () => {
    if (!selectedAccountId) {
      toast.error('Please select an email account');
      return;
    }

    setSyncing(true);

    try {
      const keywordArray = keywords
        .split(',')
        .map(k => k.trim())
        .filter(Boolean);

      const result = await syncEmails.mutateAsync({
        accountId: selectedAccountId,
        caseId,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        keywords: keywordArray.length > 0 ? keywordArray : undefined,
        maxResults: 100,
      });

      setSyncJobId(result.jobId);
      toast.info('Email sync started...');

    } catch (error: any) {
      console.error('Error syncing emails:', error);
      toast.error(`Failed to start sync: ${error.message}`);
      setSyncing(false);
    }
  };

  const handleClose = () => {
    if (!syncing) {
      onOpenChange(false);
      // Reset state
      setSyncJobId(null);
      setSelectedAccountId('');
      setKeywords('');
    }
  };

  const progress = syncJob && syncJob.totalMessages !== '0'
    ? (parseInt(syncJob.processedMessages) / parseInt(syncJob.totalMessages)) * 100
    : 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sync Emails</DialogTitle>
          <DialogDescription>
            Fetch emails from your connected account and analyze them for legal relevance.
          </DialogDescription>
        </DialogHeader>

        {!syncing ? (
          <div className="space-y-4 py-4">
            {/* Account Selection */}
            <div className="space-y-2">
              <Label htmlFor="account">Email Account</Label>
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                <SelectTrigger id="account">
                  <SelectValue placeholder="Select an account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts?.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      <div className="flex items-center gap-2">
                        <Mail className="h-4 w-4" />
                        <span>{account.email}</span>
                        <Badge variant="outline" className="text-xs">
                          {account.provider}
                        </Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {accounts?.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No connected accounts. Please connect an account first.
                </p>
              )}
            </div>

            {/* Date Range */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date</Label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="startDate"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">End Date</Label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="endDate"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
            </div>

            {/* Keywords */}
            <div className="space-y-2">
              <Label htmlFor="keywords">Keywords (optional)</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="keywords"
                  placeholder="e.g., termination, contract, dispute"
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  className="pl-10"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Separate multiple keywords with commas
              </p>
            </div>

            {/* Info */}
            <div className="bg-muted p-3 rounded-lg text-sm">
              <p className="font-medium mb-1">What happens next?</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li>• We'll fetch up to 100 emails matching your criteria</li>
                <li>• Each email is analyzed for legal relevance (0-100 score)</li>
                <li>• Relevant emails are automatically added to your case</li>
                <li>• This may take 1-2 minutes depending on email count</li>
              </ul>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-6">
            {/* Syncing Progress */}
            <div className="flex flex-col items-center gap-4">
              {syncJob?.status === 'completed' ? (
                <>
                  <CheckCircle2 className="h-12 w-12 text-green-500" />
                  <div className="text-center">
                    <p className="font-medium">Sync Complete!</p>
                    <p className="text-sm text-muted-foreground">
                      Found {syncJob.totalMessages} emails
                    </p>
                  </div>
                </>
              ) : syncJob?.status === 'failed' ? (
                <>
                  <AlertCircle className="h-12 w-12 text-destructive" />
                  <div className="text-center">
                    <p className="font-medium">Sync Failed</p>
                    <p className="text-sm text-muted-foreground">
                      {syncJob.errorMessage || 'Unknown error'}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <Loader2 className="h-12 w-12 animate-spin text-primary" />
                  <div className="text-center w-full">
                    <p className="font-medium mb-2">
                      {syncJob?.status === 'running' ? 'Analyzing emails...' : 'Starting sync...'}
                    </p>
                    {syncJob && syncJob.totalMessages !== '0' && (
                      <>
                        <p className="text-sm text-muted-foreground mb-3">
                          {syncJob.processedMessages} / {syncJob.totalMessages} emails processed
                        </p>
                        <Progress value={progress} className="w-full" />
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          {!syncing ? (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button 
                onClick={handleSync} 
                disabled={!selectedAccountId || syncEmails.isPending}
              >
                {syncEmails.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Starting...
                  </>
                ) : (
                  'Start Sync'
                )}
              </Button>
            </>
          ) : (
            <Button 
              onClick={handleClose} 
              disabled={syncJob?.status === 'running' || syncJob?.status === 'pending'}
            >
              {syncJob?.status === 'completed' || syncJob?.status === 'failed' ? 'Close' : 'Syncing...'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

