import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HelpCircle, Mail, ChevronDown, ChevronUp, Send } from "lucide-react";
import { toast } from "sonner";

export default function Help() {
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);
  const [supportForm, setSupportForm] = useState({
    category: "",
    subject: "",
    message: ""
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitTicket = trpc.support.submitTicket.useMutation({
    onSuccess: (result) => {
      toast.success(`Support ticket ${result.id} submitted.`);
      toast.message("Ticket destination", {
        description: "Your message is stored in LARO support tickets and queued for support follow-up.",
      });
      setSupportForm({ category: "", subject: "", message: "" });
      setIsSubmitting(false);
    },
    onError: (err) => {
      toast.error(err.message || "Could not submit ticket");
      setIsSubmitting(false);
    },
  });

  const faqs = [
    {
      question: "How does LARO find lawyers for my case?",
      answer: "LARO classifies the case, applies legal-area and location filters, and ranks the loaded lawyer directory records. Review the match reasons and source profile before contacting anyone.",
    },
    {
      question: "How long does it take to get a response from lawyers?",
      answer: "Response times vary by lawyer and case. The Outreach workspace shows the status and recorded response time for each contact; LARO does not guarantee that a lawyer will respond.",
    },
    {
      question: "Is my information secure?",
      answer: "LARO scopes records to the signed-in account and provides export, consent, and deletion controls. Security and legal compliance also depend on how the operator configures, hosts, and manages the installation.",
    },
    {
      question: "Can I upload evidence from my email or cloud storage?",
      answer: "LARO supports direct uploads, the consent-based desktop folder scanner, and read-only Gmail and Google Drive collection when Google OAuth is configured. A connector is usable only when its provider status reports that it is available.",
    },
    {
      question: "What if I need to clarify something about my case?",
      answer: "The Assistant is available in the top bar of each workspace. Pending clarification questions appear in the overview and in the assistant.",
    },
  ];

  const handleSupportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!supportForm.category || !supportForm.subject || !supportForm.message) {
      toast.error("Please fill in all fields");
      return;
    }
    setIsSubmitting(true);
    submitTicket.mutate({
      category: supportForm.category,
      subject: supportForm.subject,
      message: supportForm.message,
    });
  };

  return (
    <DashboardLayout>
      <div className="max-w-5xl space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Help & Resources
          </h1>
        </div>

        {/* FAQs - Collapsible */}
        <section className="space-y-4">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <HelpCircle className="w-6 h-6 text-orange-500" />
            Frequently Asked Questions
          </h2>
          <div className="space-y-3">
            {faqs.map((faq, index) => (
              <Card
                key={faq.question}
                className="overflow-hidden border-border/50 bg-card/50 backdrop-blur-sm transition-all hover:border-orange-500/30"
              >
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-4 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                  aria-expanded={expandedFaq === index}
                  aria-controls={`faq-answer-${index}`}
                  onClick={() => setExpandedFaq(expandedFaq === index ? null : index)}
                >
                  <span className="font-semibold text-foreground">{faq.question}</span>
                  {expandedFaq === index ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
                {expandedFaq === index && (
                  <CardContent id={`faq-answer-${index}`} className="pt-0 pb-4 text-sm text-muted-foreground animate-in slide-in-from-top-2">
                    <p className="border-t border-border/50 pt-3">{faq.answer}</p>
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        </section>

        {/* Contact Support Form */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Mail className="w-6 h-6 text-orange-500" />
            Contact Support
          </h2>
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-lg">Open a Support Ticket</CardTitle>
              <CardDescription>Tickets are stored in this LARO installation for operator follow-up. Response time depends on the support process configured for your installation.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSupportSubmit} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="category">Category</Label>
                    <Select
                      value={supportForm.category}
                      onValueChange={(v: any) => setSupportForm({ ...supportForm, category: v })}
                    >
                      <SelectTrigger id="category" aria-label="Support ticket category">
                        <SelectValue placeholder="Select a topic" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="account">Account Access</SelectItem>
                        <SelectItem value="matching">Lawyer Matching</SelectItem>
                        <SelectItem value="evidence">Evidence Collection</SelectItem>
                        <SelectItem value="connections">Connections & Providers</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="subject">Subject</Label>
                    <Input
                      id="subject"
                      placeholder="Brief summary of the issue"
                      value={supportForm.subject}
                      onChange={(e) => setSupportForm({ ...supportForm, subject: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="message">How can we help?</Label>
                  <Textarea
                    id="message"
                    placeholder="Describe your issue in detail..."
                    rows={6}
                    value={supportForm.message}
                    onChange={(e) => setSupportForm({ ...supportForm, message: e.target.value })}
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    disabled={isSubmitting}
                    className="bg-orange-500 hover:bg-orange-600 min-w-[140px]"
                  >
                    {isSubmitting ? (
                      "Sending..."
                    ) : (
                      <>
                        <Send className="w-4 h-4 mr-2" />
                        Send Message
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </section>
      </div>
    </DashboardLayout>
  );
}
