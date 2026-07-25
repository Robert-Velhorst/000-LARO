import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CircleHelp, Loader2, MessageSquare, X, Send, Minimize2, Maximize2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { getElectronAPI } from "@/lib/electronApiShim";

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
}

export default function ChatWidget({ embedded = false }: { embedded?: boolean }) {
  const [location] = useLocation();
  const [isOpen, setIsOpen] = useState(embedded);
  const [isMinimized, setIsMinimized] = useState(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      role: "assistant",
      content: "Hi! I'm LARO, your legal assistant. I'm here to help clarify any questions about your cases. Feel free to ask me anything!",
      timestamp: new Date(),
    },
  ]);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { data: pendingQuestions } = trpc.clarifications.pending.useQuery(undefined, {
    enabled: isOpen,
    refetchInterval: 30000, // Refetch every 30 seconds
  });
  const answerMutation = trpc.clarifications.answer.useMutation({
    onSuccess: () => {
      toast.success("Answer recorded successfully!");
    },
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

  const handleSend = async () => {
    if (!message.trim() || askAssistantMutation.isPending) return;

    const outgoingMessage = message;
    const newMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: outgoingMessage,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, newMessage]);
    setMessage("");

    // Check if this is answering a pending question
    const lastAssistantMessage = messages.filter(m => m.role === "assistant").slice(-1)[0];
    const matchingQuestion = pendingQuestions?.find(q => 
      lastAssistantMessage?.content.includes(q.question)
    );

    if (matchingQuestion) {
      // Record answer to clarification question
      answerMutation.mutate({
        questionId: matchingQuestion.id,
        answer: outgoingMessage,
      });

      const response: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: "Thank you! I've recorded your answer and will use it to improve your case matching.",
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, response]);
    } else {
      const caseIdFromLocalStorage =
        typeof window !== "undefined" ? localStorage.getItem("active-case-context-id") || undefined : undefined;
      try {
        const result = await askAssistantMutation.mutateAsync({
          question: outgoingMessage,
          caseId: caseIdFromLocalStorage,
          page: location,
        });
        const response: Message = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: result.answer,
          timestamp: new Date(),
          citations: result.citations,
          notice: result.notice,
        };
        setMessages(prev => [...prev, response]);
      } catch {
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
              ? `flex h-full min-h-[420px] max-h-[640px] flex-col border-border/50 bg-card/95 shadow-md ${isMinimized ? "min-h-14" : ""}`
              : `fixed bottom-3 left-3 right-3 z-50 shadow-2xl border-border/50 bg-card/95 backdrop-blur-lg transition-all duration-300 sm:bottom-6 sm:left-auto sm:right-6 ${
                  isMinimized ? "h-14 sm:w-80" : "h-[calc(100dvh-1.5rem)] sm:h-[600px] sm:w-96"
                }`
          }
        >
          {/* Header */}
          <CardHeader className="flex flex-row items-center justify-between p-4 border-b border-border/50">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-gradient-to-r from-orange-500 to-orange-600 flex items-center justify-center">
                <MessageSquare className="h-5 h-5 text-white" />
              </div>
              <div>
                <CardTitle className="text-base">LARO Assistant</CardTitle>
                {pendingCount > 0 && !isMinimized && (
                  <p className="text-xs text-muted-foreground">
                    {pendingCount} pending question{pendingCount > 1 ? "s" : ""}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button
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
              </Button>
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

          {/* Messages */}
          {!isMinimized && (
            <>
              <CardContent
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
                          ? "bg-gradient-to-r from-orange-500 to-orange-600 text-white"
                          : "bg-muted text-foreground"
                      }`}
                    >
                      <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
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
                      <p className={`text-xs mt-1 ${msg.role === "user" ? "text-orange-100" : "text-muted-foreground"}`}>
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
                    placeholder="Type your message..."
                    aria-label="Message LARO assistant"
                    className="flex-1"
                  />
                  <Button
                    onClick={handleSend}
                    size="icon"
                    aria-label="Send message"
                    className="bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700"
                    disabled={!message.trim() || askAssistantMutation.isPending}
                  >
                    {askAssistantMutation.isPending
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Send className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Case answers use analyzed documents when a case is selected. Verify the linked sources before relying on them.
                </p>
              </div>
            </>
          )}
        </Card>
      )}
    </>
  );
}

