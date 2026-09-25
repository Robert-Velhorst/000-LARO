import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Circle, ExternalLink, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { useI18n } from "@/contexts/I18nContext";
import { trpc } from "@/lib/trpc";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";

type StepKey = "case" | "evidence" | "outreach";

const COPY = {
  en: {
    title: "Set up your LARO workspace",
    description: "Three real workspace milestones. Progress is tied to the signed-in account.",
    safety: "LARO organizes legal material; it does not provide legal advice. Outreach is never sent without your review and explicit approval.",
    progress: (complete: number, total: number) => `${complete} of ${total} setup steps completed`,
    step: (current: number, total: number) => `Step ${current} of ${total}`,
    complete: "Completed",
    incomplete: "Not completed yet",
    back: "Back",
    next: "Next",
    later: "Continue later",
    skip: "Skip setup",
    finish: "Finish setup",
    finishHint: "Complete the real case, evidence, and outreach milestones before finishing.",
    unavailable: "The setup guide is temporarily unavailable.",
    steps: {
      case: {
        title: "Create your first case",
        body: "Add a case to keep its facts, documents, and outreach together in your private workspace.",
        action: "Open cases",
      },
      evidence: {
        title: "Add reviewed evidence",
        body: "Upload or connect a document, review it, and attach it to a case you own.",
        action: "Open documents",
      },
      outreach: {
        title: "Prepare outreach for review",
        body: "Create an outreach draft for a case. LARO never sends it without your explicit approval.",
        action: "Open outreach",
      },
    },
  },
  nl: {
    title: "Uw LARO-werkruimte instellen",
    description: "Drie echte mijlpalen in uw werkruimte. De voortgang hoort bij het ingelogde account.",
    safety: "LARO ordent juridisch materiaal en geeft geen juridisch advies. Benadering wordt nooit verstuurd zonder uw beoordeling en uitdrukkelijke goedkeuring.",
    progress: (complete: number, total: number) => `${complete} van ${total} instelstappen voltooid`,
    step: (current: number, total: number) => `Stap ${current} van ${total}`,
    complete: "Voltooid",
    incomplete: "Nog niet voltooid",
    back: "Terug",
    next: "Volgende",
    later: "Later doorgaan",
    skip: "Instellen overslaan",
    finish: "Instellen voltooien",
    finishHint: "Voltooi eerst de echte mijlpalen voor dossier, bewijs en benadering.",
    unavailable: "De instelhulp is tijdelijk niet beschikbaar.",
    steps: {
      case: {
        title: "Maak uw eerste dossier",
        body: "Voeg een dossier toe om feiten, documenten en benadering samen te houden in uw eigen werkruimte.",
        action: "Dossiers openen",
      },
      evidence: {
        title: "Voeg beoordeeld bewijs toe",
        body: "Upload of koppel een document, beoordeel het en voeg het toe aan een dossier waarvan u eigenaar bent.",
        action: "Documenten openen",
      },
      outreach: {
        title: "Bereid benadering voor ter beoordeling",
        body: "Maak een concept voor een dossier. LARO verstuurt dit nooit zonder uw uitdrukkelijke goedkeuring.",
        action: "Benadering openen",
      },
    },
  },
} as const;

/** Mounted once inside the authenticated router for both desktop and hosted use. */
export default function OnboardingFlow() {
  const { locale } = useI18n();
  const copy = COPY[locale];
  const [, navigate] = useLocation();
  const [dismissedForSession, setDismissedForSession] = useState(false);
  const [currentStepKey, setCurrentStepKey] = useState<StepKey>("case");
  // The query has no user-id input because identity comes from the session.
  // Always refresh on a user-keyed remount so cached state never crosses accounts.
  const state = trpc.onboarding.state.useQuery(undefined, {
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const setCurrentStep = trpc.onboarding.setCurrentStep.useMutation();
  const skip = trpc.onboarding.skip.useMutation();
  const reset = trpc.onboarding.reset.useMutation();
  const complete = trpc.onboarding.complete.useMutation();

  useEffect(() => {
    if (state.data?.currentStepKey) setCurrentStepKey(state.data.currentStepKey);
  }, [state.data?.currentStepKey]);

  useEffect(() => {
    const openGuide = () => {
      void (async () => {
        try {
          setDismissedForSession(false);
          if (state.data?.status !== "active") await reset.mutateAsync();
          await state.refetch();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : copy.unavailable);
        }
      })();
    };
    window.addEventListener("laro:open-onboarding", openGuide);
    return () => window.removeEventListener("laro:open-onboarding", openGuide);
  }, [copy.unavailable, reset, state]);

  const steps = state.data?.steps ?? [];
  const currentIndex = useMemo(() => {
    const index = steps.findIndex((step) => step.key === currentStepKey);
    return index >= 0 ? index : 0;
  }, [currentStepKey, steps]);
  const current = steps[currentIndex];
  const busy = setCurrentStep.isPending || skip.isPending || reset.isPending || complete.isPending;
  // Cached data may belong to the account that just signed out. Never render
  // it until this user-keyed mount has completed its own server read.
  const open = state.isFetchedAfterMount && state.data?.status === "active" && !dismissedForSession;

  const persistStep = async (stepKey: StepKey) => {
    setCurrentStepKey(stepKey);
    try {
      await setCurrentStep.mutateAsync({ stepKey });
      await state.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.unavailable);
    }
  };

  const move = (offset: -1 | 1) => {
    const next = steps[currentIndex + offset];
    if (next) void persistStep(next.key);
  };

  const openWorkspace = async () => {
    if (!current) return;
    try {
      await setCurrentStep.mutateAsync({ stepKey: current.key });
      setDismissedForSession(true);
      navigate(current.route);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.unavailable);
    }
  };

  const skipGuide = async () => {
    try {
      await skip.mutateAsync();
      setDismissedForSession(true);
      await state.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.unavailable);
    }
  };

  const finishGuide = async () => {
    try {
      await complete.mutateAsync();
      setDismissedForSession(true);
      await state.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.finishHint);
    }
  };

  if (!state.data || !current) return null;
  const localizedStep = copy.steps[current.key];
  const progress = state.data.totalSteps
    ? (state.data.completedSteps / state.data.totalSteps) * 100
    : 0;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) setDismissedForSession(true); }}>
      <DialogContent className="max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="pr-8 text-xl">{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{copy.step(currentIndex + 1, state.data.totalSteps)}</span>
            <span>{copy.progress(state.data.completedSteps, state.data.totalSteps)}</span>
          </div>
          <Progress aria-label={copy.progress(state.data.completedSteps, state.data.totalSteps)} value={progress} />
        </div>

        <ol className="grid gap-2 sm:grid-cols-3" aria-label={copy.description}>
          {steps.map((step, index) => {
            const stepCopy = copy.steps[step.key];
            const selected = step.key === current.key;
            return (
              <li key={step.key}>
                <button
                  type="button"
                  aria-current={selected ? "step" : undefined}
                  onClick={() => void persistStep(step.key)}
                  disabled={busy}
                  className={`flex min-h-16 w-full items-start gap-2 rounded-md border p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted"}`}
                >
                  {step.complete
                    ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  <span className="min-w-0">
                    <span className="block text-xs text-muted-foreground">{index + 1}. {step.complete ? copy.complete : copy.incomplete}</span>
                    <span className="block text-sm font-medium leading-5">{stepCopy.title}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <section className="rounded-md border border-border bg-card p-4" aria-labelledby="onboarding-current-title">
          <div className="flex items-start gap-3">
            {current.complete
              ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
            <div className="min-w-0 flex-1">
              <h2 id="onboarding-current-title" className="text-base font-semibold">{localizedStep.title}</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{localizedStep.body}</p>
              <Button className="mt-4" variant="outline" onClick={() => void openWorkspace()} disabled={busy}>
                {localizedStep.action}<ExternalLink className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </section>

        <Alert>
          <ShieldCheck aria-hidden="true" />
          <AlertDescription>{copy.safety}</AlertDescription>
        </Alert>

        {currentIndex === steps.length - 1 && !state.data.canComplete && (
          <p role="status" className="text-sm text-muted-foreground">{copy.finishHint}</p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={() => void skipGuide()} disabled={busy}>{copy.skip}</Button>
          <Button variant="outline" onClick={() => setDismissedForSession(true)} disabled={busy}>{copy.later}</Button>
          <div className="min-w-0 flex-1" />
          {currentIndex > 0 && <Button variant="outline" onClick={() => move(-1)} disabled={busy}>{copy.back}</Button>}
          {currentIndex < steps.length - 1
            ? <Button onClick={() => move(1)} disabled={busy}>{copy.next}</Button>
            : <Button onClick={() => void finishGuide()} disabled={busy || !state.data.canComplete}>{copy.finish}</Button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
