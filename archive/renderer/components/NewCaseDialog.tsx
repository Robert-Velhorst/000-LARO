import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { Lightbulb } from "lucide-react";

interface NewCaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function NewCaseDialog({ open, onOpenChange }: NewCaseDialogProps) {
  const { user } = useAuth();
  const [formData, setFormData] = useState({
    caseSummary: "",
  });

  const utils = trpc.useUtils();
  const createCase = trpc.cases.create.useMutation({
    onSuccess: () => {
      toast.success("Case created and classified. Review it to match lawyers.");
      utils.cases.list.invalidate();
      utils.dashboard.recentCases.invalidate();
      utils.dashboard.stats.invalidate();
      onOpenChange(false);
      // Reset form
      setFormData({
        caseSummary: "",
      });
    },
    onError: (error: any) => {
      toast.error(`Failed to create case: ${error.message}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Basic validation
    if (!formData.caseSummary || formData.caseSummary.trim().length < 50) {
      toast.error("Please describe your situation in more detail (at least 50 characters)");
      return;
    }

    if (!user) {
      toast.error("You must be logged in to create a case");
      return;
    }

    // Legal areas are deterministically classified by the create endpoint.
    createCase.mutate({
      clientName: user.name || "User",
      clientEmail: user.email || "",
      caseType: "General",
      caseSummary: formData.caseSummary,
      urgency: "Medium", // Fixed value per client requirements
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] bg-background border-border">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
            Tell Us What Happened
          </DialogTitle>
          <DialogDescription>
            Describe your situation in your own words. Our system will analyze your story and connect you with lawyers who specialize in your type of case.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-6 py-4">
            {/* Helpful Tips */}
            <div className="flex gap-3 p-4 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <Lightbulb className="w-5 h-5 text-purple-400 flex-shrink-0 mt-0.5" />
              <div className="space-y-2 text-sm">
                <p className="font-medium text-purple-300">Tips for describing your situation:</p>
                <ul className="space-y-1 text-muted-foreground">
                  <li>• <strong>What happened?</strong> Describe the events or problem</li>
                  <li>• <strong>When?</strong> When did this occur or start?</li>
                  <li>• <strong>Who's involved?</strong> Other parties (employer, landlord, family member, etc.)</li>
                  <li>• <strong>What do you need?</strong> What outcome are you hoping for?</li>
                </ul>
                <p className="text-xs italic mt-2">Don't worry about legal terminology - just explain in your own words.</p>
              </div>
            </div>

            {/* Case Story */}
            <div className="grid gap-2">
              <Label htmlFor="caseSummary" className="text-base">Your Situation *</Label>
              <Textarea
                id="caseSummary"
                value={formData.caseSummary}
                onChange={(e) => setFormData({ ...formData, caseSummary: e.target.value })}
                placeholder="Example: My employer fired me last week after I reported safety violations to the labor inspectorate. They claim it was for performance reasons, but I have emails proving it was retaliation. I've worked there for 5 years with excellent reviews. I need help understanding my rights and possibly getting my job back or compensation."
                rows={8}
                required
                className="resize-none"
              />
              <div className="flex justify-between items-center text-xs">
                <span className={formData.caseSummary.length < 50 ? "text-muted-foreground" : "text-green-500"}>
                  {formData.caseSummary.length} characters {formData.caseSummary.length < 50 ? `(minimum 50)` : "✓"}
                </span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button 
              type="submit" 
              disabled={createCase.isPending || formData.caseSummary.length < 50} 
              className="bg-gradient-to-r from-purple-500 to-pink-500"
            >
              {createCase.isPending ? "Creating..." : "Create case"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

