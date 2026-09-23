import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CircleHelp, Loader2, MessageSquare, X, Send, Minimize2, Maximize2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { getElectronAPI } from "@/lib/electronApiShim";
import { useWebSocket } from "@/contexts/WebSocketContext";
import { CasePicker } from "@/components/WorkspaceUi";

interface MessageCitation {
  evidenceId: string;
  title: string;
  documentType: string;
  confidence: number;
  summary: string;
  matchedTerms: string[];
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  citations?: MessageCitation[];
  notice?: string | null;
  mode?: string;
  grounded?: boolean;
  caseId?: string | null;
  caseLabel?: string | null;
}

export function useChatSession() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [caseId, setCaseIdState] = useState<string | null>(null);
  const caseIdRef = useRef<string | null>(null);
  const setCaseId = useCallback((nextCaseId: string | null) => {
    // An in-flight answer must see navigation/closure before React can render.
    caseIdRef.current = nextCaseId;
    setCaseIdState(nextCaseId);
  }, []);
  return { message, setMessage, messages, setMessages, caseId, caseIdRef, setCaseId };
}

export default function ChatWidget({ embedded = false, session, ownerId = null }: { embedded?: boolean; session?: ReturnType<typeof useChatSession>; ownerId?: string | null }) {
  const { isConnected } = useWebSocket();
  const [location] = useLocation();
  const [isOpen, setIsOpen] = useState(embedded);
  const [isMinimized, setIsMinimized] = useState(false);
  const [activeClarificationId, setActiveClarificationId] = useState<string | null>(null);
  const localSession = useChatSession();
  const { message, setMessage, messages, setMessages, caseId, caseIdRef, setCaseId } = session || localSession;
  const selectedCase = trpc.cases.byId.useQuery(caseId || '', {
    enabled: Boolean(caseId && ownerId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const visibleCase = selectedCase.data?.id === caseId && selectedCase.data.userId === ownerId
    ? selectedCase.data : null;
  const selectionRef = useRef({ ownerId, caseId });
  selectionRef.current = { ownerId, caseId };
  const previousOwnerId = useRef(ownerId);
  const utils = trpc.useUtils();
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { data: pendingQuestions } = trpc.clarifications.pending.useQuery(undefined, {
    enabled: isOpen,
    refetchInterval: isConnected ? false : 60_000,
    refetchOnWindowFocus: true,
  });
  const answerMutation = trpc.clarifications.answer.useMutation({
    onError: (error: { message?: string }) => {
      toast.error(`Failed to record answer: ${error.message ?? "Unknown error"}`);
    },
  });
  const askAssistantMutation = trpc.assistant.ask.useMutation();
  const sourceMutation = trpc.evidenceFiles.getDownloadUrl.useMutation();
  const sourceOpenedMutation = trpc.evidenceFiles.recordSourceOpened.useMutation();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);
  useEffect(() => {
    if (previousOwnerId.current === ownerId) return;
    previousOwnerId.current = ownerId;
    setCaseId(null);
    setMessages([]);
    setActiveClarificationId(null);
  }, [ownerId, setCaseId, setMessages]);

  const handleSend = async () => {
    if (!message.trim() || askAssistantMutation.isPending || answerMutation.isPending) return;
    if (!ownerId || (caseId && !visibleCase)) {
      toast.error('Choose an available case before asking about its evidence');
      return;
    }

    const outgoingMessage = message;
    const requestedCaseId = visibleCase?.id ?? null;
    const requestedCaseLabel = visibleCase?.clientName || visibleCase?.caseType || visibleCase?.id || null;
    const newMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: outgoingMessage,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, newMessage]);
    setMessage("");

    // A clarification is selected explicitly. Do not infer intent by searching
    // rendered message text; that can bind an answer to the wrong case/question.
    const matchingQuestion = pendingQuestions?.find(q => q.id === activeClarificationId);

    if (matchingQuestion) {
      // Record answer to clarification question
      try {
        const result = await answerMutation.mutateAsync({ questionId: matchingQuestion.id, answer: outgoingMessage });
        setActiveClarificationId(null);
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: result.message,
          notice: result.applied
            ? `Applied outcome: ${result.outcome}`
            : `Not applied: ${result.outcome}`,
          timestamp: new Date(),
        }]);
        toast[result.applied ? "success" : "warning"](result.message);
        const invalidations: Array<Promise<unknown>> = [utils.clarifications.pending.invalidate()];
        if (result.applied) {
          invalidations.push(utils.cases.invalidate());
          if (result.affectedDerived === "lawyer_matching") invalidations.push(utils.matching.invalidate());
          if (result.affectedDerived === "outreach") invalidations.push(utils.outreachDirectory.invalidate());
          if (result.affectedDerived === "deadlines") invalidations.push(utils.caseManagement.invalidate());
        }
        await Promise.all(invalidations);
      } catch {
        setMessage(outgoingMessage);
      }
    } else {
      try {
        const result = await askAssistantMutation.mutateAsync({
          question: outgoingMessage,
          caseId: requestedCaseId || undefined,
          expectedUserId: ownerId,
          page: location,
        });
        if (result.caseId !== requestedCaseId || result.ownerId !== ownerId ||
            caseIdRef.current !== requestedCaseId || selectionRef.current.ownerId !== ownerId) {
          toast.info('The selected account or case changed; the previous answer was discarded.');
          return;
        }
        const response: Message = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: result.answer,
          timestamp: new Date(),
          citations: result.citations,
          notice: result.notice,
          mode: result.mode,
          grounded: result.grounded,
          caseId: result.caseId,
          caseLabel: requestedCaseLabel,
        };
        setMessages(prev => [...prev, response]);
      } catch {
        if (caseIdRef.current !== requestedCaseId || selectionRef.current.ownerId !== ownerId) return;
        setMessage((current) => current || outgoingMessage);
        const fallback: Message = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: "I could not process that right now. Please try again.",
          timestamp: new Date(),
        };
        setMessages(prev => [...prev, fallback]);
      }
    }
  };

  const openSource = async (citation: MessageCitation) => {
    try {
      const source = await sourceMutation.mutateAsync({ id: citation.evidenceId });
      if (!source.url) throw new Error(source.message || "The source file is not available.");
      await getElectronAPI().openExternal(source.url);
      await sourceOpenedMutation.mutateAsync({ id: citation.evidenceId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The source document could not be opened.");
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const pendingCount = pendingQuestions?.length || 0;

  return (
    <>
      {/* Floating Chat Button (hidden on dashboard embedded chat) */}
      {!embedded && !isOpen && (
        <Button
          onClick={() => setIsOpen(true)}
          aria-label="Open LARO assistant"
          className="fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-2xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 z-50 transition-all duration-300 hover:scale-110"
          size="icon"
        >
          <MessageSquare className="h-6 w-6" />
          {pendingCount > 0 && (
            <Badge 
              className="absolute -top-1 -right-1 h-6 w-6 rounded-full p-0 flex items-center justify-center bg-red-500 text-white text-xs"
            >
              {pendingCount}
            </Badge>
          )}
        </Button>
      )}

      {/* Chat Panel */}
      {isOpen && (
        <Card 
          className={
            embedded
              ? "flex h-[min(600px,calc(100dvh_-_4rem))] min-h-0 flex-col rounded-none border-0 bg-background"
              : `fixed bottom-3 left-3 right-3 z-50 shadow-2xl border-border/50 bg-card/95 backdrop-blur-lg transition-all duration-300 sm:bottom-6 sm:left-auto sm:right-6 ${
                  isMinimized ? "h-14 sm:w-80" : "h-[calc(100dvh-1.5rem)] sm:h-[600px] sm:w-96"
                }`
          }
        >
          {/* Header */}
          <CardHeader className={`flex flex-row items-center justify-between border-b border-border p-4 ${embedded ? "pr-12" : ""}`}>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10">
                <MessageSquare className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">LARO Assistant</CardTitle>
                {!isMinimized && (
                  <p className="text-xs text-muted-foreground">
                    {caseId ? (visibleCase ? `Source-grounded case mode: ${visibleCase.clientName || visibleCase.caseType || visibleCase.id}` : 'Checking selected case...') : "Product help mode"}
                  </p>
                )}
                {pendingCount > 0 && !isMinimized && (
                  <p className="text-xs text-muted-foreground">
                    {pendingCount} pending question{pendingCount > 1 ? "s" : ""}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {!embedded && <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsMinimized(!isMinimized)}
                aria-label={isMinimized ? "Expand LARO assistant" : "Minimize LARO assistant"}
                className="h-8 w-8"
              >
                {isMinimized ? (
                  <Maximize2 className="h-4 w-4" />
                ) : (
                  <Minimize2 className="h-4 w-4" />
                )}
              </Button>}
              {!embedded && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsOpen(false)}
                  aria-label="Close LARO assistant"
                  className="h-8 w-8"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </CardHeader>
          {!isMinimized && <div className="border-b border-border px-4 py-2">
            <CasePicker value={caseId} ownerId={ownerId} onChange={(id) => { setActiveClarificationId(null); setMessages([]); setCaseId(id); }} disabled={askAssistantMutation.isPending || answerMutation.isPending} emptyLabel="Product help (no case)" />
          </div>}

          {/* Messages */}
          {!isMinimized && (
            <>
              <CardContent
                role="region"
                aria-label="Assistant conversation and pending questions"
                tabIndex={0}
                className={
                  embedded
                    ? "flex-1 overflow-y-auto p-4 space-y-4 min-h-0"
                    : "flex-1 min-h-0 overflow-y-auto p-4 space-y-4"
                }
              >
                {/* Pending Questions */}
                {pendingQuestions && pendingQuestions.length > 0 && (
                  <div className="mb-4 p-3 rounded-lg bg-orange-500/10 border border-orange-500/20">
                    <p className="text-sm font-semibold text-orange-500 mb-2">Pending Questions:</p>
                    {pendingQuestions.map((q) => (
                      <div key={q.id} className="text-sm text-foreground mb-2 last:mb-0">
                        <p className="font-medium">• {q.question}</p>
                        <Button
                          variant={activeClarificationId === q.id ? "secondary" : "ghost"}
                          size="sm"
                          aria-pressed={activeClarificationId === q.id}
                          onClick={() => {
                            setActiveClarificationId(q.id);
                            setMessages([]);
                            setCaseId(q.caseId);
                            setMessages([{
                              id: crypto.randomUUID(),
                              role: "assistant",
                              content: q.question,
                              notice: q.affectsMatching
                                ? "A validated answer will update this case and refresh matching."
                                : "The answer will be validated and its applied or review outcome will be shown.",
                              timestamp: new Date(),
                            }]);
                          }}
                        >
                          {activeClarificationId === q.id ? "Selected" : "Answer"}
                        </Button>
                        {q.context && (
                          <p className="text-xs text-muted-foreground ml-3 mt-1">{q.context}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-lg p-3 ${
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-foreground"
                      }`}
                    >
                      {msg.role === "assistant" && msg.mode ? (
                        <Badge variant="outline" className="mb-2 text-[10px]">
                          {assistantModeLabel(msg.mode, Boolean(msg.grounded))}
                        </Badge>
                      ) : null}
                      {msg.role === 'assistant' && msg.caseId && (
                        <p className="mb-2 text-xs font-medium" aria-label="Answer case identity">Case: {msg.caseLabel || msg.caseId}</p>
                      )}
                      <p className="whitespace-pre-wrap break-words text-sm">{msg.content}</p>
                      {msg.notice ? (
                        <p className="mt-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
                          {msg.notice}
                        </p>
                      ) : null}
                      {msg.citations?.length ? (
                        <div className="mt-3 space-y-1.5 border-t border-border/60 pt-2" aria-label="Answer sources">
                          {msg.citations.map((citation) => (
                            <button
                              key={citation.evidenceId}
                              type="button"
                              className="flex w-full items-start gap-2 border border-border/70 bg-background/70 p-2 text-left hover:bg-background"
                              title={`Open source document ${citation.title}`}
                              onClick={() => void openSource(citation)}
                            >
                              <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
                              <span className="min-w-0">
                                <span className="block truncate text-xs font-medium">{citation.title}</span>
                                <span className="block text-[11px] text-muted-foreground">
                                  {citation.documentType} - {citation.confidence}% analysis confidence
                                </span>
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <p className={`text-xs mt-1 ${msg.role === "user" ? "text-primary-foreground/80" : "text-muted-foreground"}`}>
                        {msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </CardContent>

              {/* Input */}
              <div className="p-4 border-t border-border/50">
                <div className="flex gap-2">
                  <Input
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyPress={handleKeyPress}
                    placeholder={activeClarificationId
                      ? "Answer the selected clarification..."
                      : caseId
                        ? "Ask about the selected case..."
                        : "Ask how to use LARO..."}
                    aria-label="Message LARO assistant"
                    className="flex-1"
                  />
                  <Button
                    onClick={handleSend}
                    size="icon"
                    aria-label="Send message"
                    disabled={!message.trim() || !ownerId || Boolean(caseId && !visibleCase) || askAssistantMutation.isPending || answerMutation.isPending}
                  >
                    {askAssistantMutation.isPending
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Send className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  {caseId
                    ? "Case answers use analyzed owned documents. Verify the linked sources before relying on them."
                    : "Product help only. Select a case for source-grounded case questions; uncited legal conclusions are unavailable."}
                </p>
              </div>
            </>
          )}
        </Card>
      )}
    </>
  );
}

function assistantModeLabel(mode: string, grounded: boolean): string {
  if (grounded && mode === "provider") return "Grounded case analysis";
  if (grounded && mode === "retrieval") return "Grounded source summary";
  if (mode === "product_help") return "Product help";
  if (mode === "case_required") return "Case selection required";
  if (mode === "no_sources") return "Case sources unavailable";
  if (mode === "no_match") return "No source match";
  return "Unavailable";
}
