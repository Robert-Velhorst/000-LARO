/**
 * Trello Integration Component
 * Allows users to connect Trello and sync boards, lists, and cards as evidence
 */

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, CheckSquare, AlertCircle, Trash2, RefreshCw } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { toast } from 'sonner';

interface TrelloSimpleProps {
  caseId: string;
}

interface TrelloBoard {
  id: string;
  name: string;
  url: string;
  desc?: string;
}

interface TrelloList {
  id: string;
  name: string;
  boardId: string;
}

interface TrelloCard {
  id: string;
  name: string;
  desc?: string;
  url: string;
  listId: string;
  boardId: string;
  dateLastActivity?: string;
  attachments?: Array<{
    id: string;
    name: string;
    url: string;
  }>;
}

export default function TrelloSimple({ caseId }: TrelloSimpleProps) {
  const [token, setToken] = useState<string>('');
  const [boards, setBoards] = useState<TrelloBoard[]>([]);
  const [lists, setLists] = useState<TrelloList[]>([]);
  const [cards, setCards] = useState<TrelloCard[]>([]);
  const [selectedBoards, setSelectedBoards] = useState<Set<string>>(new Set());
  const [selectedLists, setSelectedLists] = useState<Set<string>>(new Set());
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [step, setStep] = useState<'connect' | 'boards' | 'lists' | 'cards' | 'sync'>('connect');
  const [error, setError] = useState<string>('');

  // Get Trello status
  const { data: status } = trpc.trello.getStatus.useQuery({ caseId });

  // List boards mutation
  const listBoardsMutation = trpc.trello.listBoards.useMutation({
    onSuccess: (data) => {
      setBoards(data.boards);
      setStep('boards');
      toast.success(`Found ${data.count} Trello boards`);
    },
    onError: (error) => {
      setError(error.message);
      toast.error('Failed to fetch boards');
    },
  });

  // List lists mutation
  const listListsMutation = trpc.trello.listLists.useMutation({
    onSuccess: (data) => {
      setLists(data.lists);
      setStep('lists');
      toast.success(`Found ${data.count} Trello lists`);
    },
    onError: (error) => {
      setError(error.message);
      toast.error('Failed to fetch lists');
    },
  });

  // List cards mutation
  const listCardsMutation = trpc.trello.listCards.useMutation({
    onSuccess: (data) => {
      setCards(data.cards);
      setStep('cards');
      toast.success(`Found ${data.count} Trello cards`);
    },
    onError: (error) => {
      setError(error.message);
      toast.error('Failed to fetch cards');
    },
  });

  // Sync mutation
  const syncMutation = trpc.trello.syncBoards.useMutation({
    onSuccess: (data) => {
      setSyncing(false);
      toast.success('Trello sync completed successfully!');
      setStep('sync');
      // Reset state
      setToken('');
      setBoards([]);
      setLists([]);
      setCards([]);
      setSelectedBoards(new Set());
      setSelectedLists(new Set());
      setSelectedCards(new Set());
    },
    onError: (error) => {
      setSyncing(false);
      setError(error.message);
      toast.error('Failed to sync Trello');
    },
  });

  // Get OAuth URL mutation
  const getOAuthUrlMutation = trpc.trello.getOAuthUrl.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        // Open OAuth URL in new window
        window.open(data.authUrl, 'trello-oauth', 'width=600,height=700');
      }
    },
    onError: (error) => {
      setError(error.message);
      toast.error('Failed to get OAuth URL');
    },
  });

  // Disconnect mutation
  const disconnectMutation = trpc.trello.disconnect.useMutation({
    onSuccess: () => {
      toast.success('Trello disconnected');
      setStep('connect');
      setToken('');
      setError('');
    },
    onError: (error) => {
      toast.error('Failed to disconnect');
    },
  });

  // Handle OAuth callback
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const oauthToken = urlParams.get('token');
    
    if (oauthToken) {
      setToken(oauthToken);
      // Remove token from URL
      window.history.replaceState({}, document.title, window.location.pathname);
      // Fetch boards
      listBoardsMutation.mutate({ caseId, token: oauthToken });
    }
  }, [caseId]);

  const handleGetOAuthUrl = () => {
    setError('');
    getOAuthUrlMutation.mutate({ caseId });
  };

  const handleBoardToggle = (boardId: string) => {
    const newSelected = new Set(selectedBoards);
    if (newSelected.has(boardId)) {
      newSelected.delete(boardId);
    } else {
      newSelected.add(boardId);
    }
    setSelectedBoards(newSelected);
  };

  const handleListToggle = (listId: string) => {
    const newSelected = new Set(selectedLists);
    if (newSelected.has(listId)) {
      newSelected.delete(listId);
    } else {
      newSelected.add(listId);
    }
    setSelectedLists(newSelected);
  };

  const handleCardToggle = (cardId: string) => {
    const newSelected = new Set(selectedCards);
    if (newSelected.has(cardId)) {
      newSelected.delete(cardId);
    } else {
      newSelected.add(cardId);
    }
    setSelectedCards(newSelected);
  };

  const handleSync = async () => {
    if (selectedBoards.size === 0) {
      toast.error('Please select at least one board');
      return;
    }

    setSyncing(true);
    syncMutation.mutate({
      caseId,
      token,
      boardIds: Array.from(selectedBoards),
    });
  };

  const handleDisconnect = () => {
    disconnectMutation.mutate({ caseId });
  };

  // Connected state
  if (status?.connected && step === 'connect') {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckSquare className="w-5 h-5 text-green-600" />
            Trello Connected
          </CardTitle>
          <CardDescription>
            {status.itemCount} items synced
            {status.lastSyncedAt && ` • Last synced: ${new Date(status.lastSyncedAt).toLocaleDateString()}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Button onClick={handleGetOAuthUrl} variant="outline" disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Re-sync Boards
            </Button>
            <Button onClick={handleDisconnect} variant="destructive">
              <Trash2 className="w-4 h-4 mr-2" />
              Disconnect
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Connect step
  if (step === 'connect') {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckSquare className="w-5 h-5" />
            Trello Integration
          </CardTitle>
          <CardDescription>
            Connect your Trello account to collect boards, lists, and cards as evidence
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Click below to authorize LARO to access your Trello account. You'll be redirected to Trello to grant permissions.
            </p>
            <Button
              onClick={handleGetOAuthUrl}
              disabled={getOAuthUrlMutation.isPending}
              className="w-full"
            >
              {getOAuthUrlMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Connect with Trello
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Boards selection step
  if (step === 'boards') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Select Boards to Sync</CardTitle>
          <CardDescription>
            Choose which Trello boards you want to collect as evidence
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {boards.map((board) => (
              <div key={board.id} className="flex items-center space-x-2 p-2 hover:bg-muted rounded">
                <Checkbox
                  id={board.id}
                  checked={selectedBoards.has(board.id)}
                  onCheckedChange={() => handleBoardToggle(board.id)}
                />
                <label htmlFor={board.id} className="flex-1 cursor-pointer">
                  <div className="font-medium">{board.name}</div>
                  {board.desc && <div className="text-sm text-muted-foreground">{board.desc}</div>}
                </label>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => {
                if (selectedBoards.size > 0) {
                  const boardId = Array.from(selectedBoards)[0];
                  listListsMutation.mutate({
                    caseId,
                    boardId,
                    token,
                  });
                }
              }}
              disabled={selectedBoards.size === 0 || listListsMutation.isPending}
            >
              {listListsMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Next: View Lists
            </Button>
            <Button onClick={() => setStep('connect')} variant="outline">
              Back
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Lists selection step
  if (step === 'lists') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Select Lists to Sync</CardTitle>
          <CardDescription>
            Choose which lists you want to collect
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {lists.map((list) => (
              <div key={list.id} className="flex items-center space-x-2 p-2 hover:bg-muted rounded">
                <Checkbox
                  id={list.id}
                  checked={selectedLists.has(list.id)}
                  onCheckedChange={() => handleListToggle(list.id)}
                />
                <label htmlFor={list.id} className="flex-1 cursor-pointer">
                  <div className="font-medium">{list.name}</div>
                </label>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => {
                if (selectedLists.size > 0) {
                  const listId = Array.from(selectedLists)[0];
                  const boardId = lists.find(l => l.id === listId)?.boardId || '';
                  listCardsMutation.mutate({
                    caseId,
                    boardId,
                    listId,
                    token,
                  });
                }
              }}
              disabled={selectedLists.size === 0 || listCardsMutation.isPending}
            >
              {listCardsMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Next: View Cards
            </Button>
            <Button onClick={() => setStep('boards')} variant="outline">
              Back
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Cards selection step
  if (step === 'cards') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Select Cards to Sync</CardTitle>
          <CardDescription>
            Choose which cards you want to collect as evidence
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {cards.map((card) => (
              <div key={card.id} className="flex items-center space-x-2 p-2 hover:bg-muted rounded">
                <Checkbox
                  id={card.id}
                  checked={selectedCards.has(card.id)}
                  onCheckedChange={() => handleCardToggle(card.id)}
                />
                <label htmlFor={card.id} className="flex-1 cursor-pointer">
                  <div className="font-medium">{card.name}</div>
                  {card.desc && <div className="text-sm text-muted-foreground line-clamp-1">{card.desc}</div>}
                  {card.attachments && card.attachments.length > 0 && (
                    <Badge variant="secondary" className="mt-1">
                      {card.attachments.length} attachment{card.attachments.length !== 1 ? 's' : ''}
                    </Badge>
                  )}
                </label>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              onClick={handleSync}
              disabled={selectedCards.size === 0 || syncing}
            >
              {syncing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              Sync Selected Cards
            </Button>
            <Button onClick={() => setStep('lists')} variant="outline">
              Back
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Sync complete step
  if (step === 'sync') {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckSquare className="w-5 h-5 text-green-600" />
            Sync Complete
          </CardTitle>
          <CardDescription>
            Your Trello data has been collected and stored as evidence
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-green-50 dark:bg-green-950 p-4 rounded-lg">
            <p className="text-sm text-green-800 dark:text-green-200">
              ✓ Trello boards, lists, and cards have been synced successfully
            </p>
          </div>
          <Button onClick={() => setStep('connect')} className="w-full">
            Sync More Boards
          </Button>
        </CardContent>
      </Card>
    );
  }

  return null;
}
