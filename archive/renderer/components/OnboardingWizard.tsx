import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Briefcase, FileText, Scale, CheckCircle2, ArrowRight, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  content: React.ReactNode;
}

export function OnboardingWizard() {
  const [open, setOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    // Check if user has seen onboarding
    const hasSeenOnboarding = localStorage.getItem("hasSeenOnboarding");
    if (!hasSeenOnboarding) {
      // Show onboarding after a short delay
      const timer = setTimeout(() => {
        setOpen(true);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, []);

  const steps: OnboardingStep[] = [
    {
      id: "welcome",
      title: "Welcome to Your Legal Dashboard",
      description: "Let's get you started with managing your legal cases",
      icon: <Scale className="h-12 w-12 text-primary" />,
      content: (
        <div className="space-y-4">
          <p className="text-muted-foreground">
            This platform helps you manage legal cases, connect with qualified lawyers, and organize evidence efficiently.
          </p>
          <div className="grid gap-3">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
              <Briefcase className="h-5 w-5 text-primary mt-0.5" />
              <div>
                <p className="font-medium">Case Management</p>
                <p className="text-sm text-muted-foreground">Track and organize all your legal matters</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
              <Scale className="h-5 w-5 text-primary mt-0.5" />
              <div>
                <p className="font-medium">Lawyer Matching</p>
                <p className="text-sm text-muted-foreground">Connect with 12,000+ qualified Dutch lawyers</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
              <FileText className="h-5 w-5 text-primary mt-0.5" />
              <div>
                <p className="font-medium">Evidence Management</p>
                <p className="text-sm text-muted-foreground">AI-powered document analysis and organization</p>
              </div>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "create-case",
      title: "Create Your First Case",
      description: "Start by describing your legal issue",
      icon: <Briefcase className="h-12 w-12 text-primary" />,
      content: (
        <div className="space-y-4">
          <p className="text-muted-foreground">
            Creating a case is simple. Just provide basic information about your legal matter:
          </p>
          <ol className="space-y-3 list-decimal list-inside text-sm">
            <li>Click the <strong>"New Case"</strong> button in the top right</li>
            <li>Describe your legal issue in your own words</li>
            <li>Upload any relevant documents or evidence</li>
            <li>Our AI will analyze your case and suggest next steps</li>
          </ol>
          <div className="p-4 rounded-lg bg-primary/10 border border-primary/20">
            <p className="text-sm font-medium text-primary">💡 Tip</p>
            <p className="text-sm text-muted-foreground mt-1">
              The more details you provide, the better we can match you with the right lawyer
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "find-lawyers",
      title: "Find the Right Lawyer",
      description: "Our AI matches you with qualified professionals",
      icon: <Scale className="h-12 w-12 text-primary" />,
      content: (
        <div className="space-y-4">
          <p className="text-muted-foreground">
            Once you create a case, our system automatically:
          </p>
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="h-6 w-6 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="text-xs font-bold text-primary">1</span>
              </div>
              <div>
                <p className="font-medium">Analyzes your case type</p>
                <p className="text-sm text-muted-foreground">Identifies the legal areas involved</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="h-6 w-6 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="text-xs font-bold text-primary">2</span>
              </div>
              <div>
                <p className="font-medium">Searches our database</p>
                <p className="text-sm text-muted-foreground">Finds lawyers with relevant expertise</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="h-6 w-6 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="text-xs font-bold text-primary">3</span>
              </div>
              <div>
                <p className="font-medium">Ranks by fit</p>
                <p className="text-sm text-muted-foreground">Uses our LARO scoring system</p>
              </div>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "keyboard-shortcuts",
      title: "Work Faster with Shortcuts",
      description: "Power user tips for efficient navigation",
      icon: <CheckCircle2 className="h-12 w-12 text-primary" />,
      content: (
        <div className="space-y-4">
          <p className="text-muted-foreground">
            Save time with these keyboard shortcuts:
          </p>
          <div className="space-y-2">
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
              <span className="text-sm">Open search</span>
              <kbd className="px-2 py-1 text-xs bg-background border border-border rounded">Ctrl + K</kbd>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
              <span className="text-sm">Create new case</span>
              <kbd className="px-2 py-1 text-xs bg-background border border-border rounded">Ctrl + N</kbd>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
              <span className="text-sm">Go to home</span>
              <kbd className="px-2 py-1 text-xs bg-background border border-border rounded">Ctrl + H</kbd>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
              <span className="text-sm">Show all shortcuts</span>
              <kbd className="px-2 py-1 text-xs bg-background border border-border rounded">Ctrl + /</kbd>
            </div>
          </div>
        </div>
      ),
    },
  ];

  const handleComplete = () => {
    localStorage.setItem("hasSeenOnboarding", "true");
    setOpen(false);
  };

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleComplete();
    }
  };

  const handlePrevious = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const currentStepData = steps[currentStep];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center justify-center mb-4">
            {currentStepData.icon}
          </div>
          <DialogTitle className="text-center text-2xl">{currentStepData.title}</DialogTitle>
          <DialogDescription className="text-center">{currentStepData.description}</DialogDescription>
        </DialogHeader>

        <div className="py-6">{currentStepData.content}</div>

        {/* Progress indicators */}
        <div className="flex items-center justify-center gap-2 mb-4">
          {steps.map((step, index) => (
            <button
              key={step.id}
              onClick={() => setCurrentStep(index)}
              className={cn(
                "h-2 rounded-full transition-all",
                index === currentStep ? "w-8 bg-primary" : "w-2 bg-muted hover:bg-muted-foreground/50"
              )}
              aria-label={`Go to step ${index + 1}`}
            />
          ))}
        </div>

        {/* Navigation buttons */}
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={handlePrevious}
            disabled={currentStep === 0}
            className={cn(currentStep === 0 && "invisible")}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Previous
          </Button>

          <Button onClick={handleNext}>
            {currentStep === steps.length - 1 ? (
              <>
                Get Started
                <CheckCircle2 className="h-4 w-4 ml-2" />
              </>
            ) : (
              <>
                Next
                <ArrowRight className="h-4 w-4 ml-2" />
              </>
            )}
          </Button>
        </div>

        <button
          onClick={handleComplete}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors text-center w-full mt-2"
        >
          Skip tutorial
        </button>
      </DialogContent>
    </Dialog>
  );
}

