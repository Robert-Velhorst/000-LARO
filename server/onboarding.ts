/**
 * Phase 105 — onboarding & first-run experience.
 *
 * Defines the ordered first-run steps and tracks, per user, whether onboarding
 * has been completed. Completion is stored in system_config under a per-user key
 * so the renderer can decide whether to show the first-run wizard. The step
 * content is real and mirrors the user guide (Phase 071).
 */
import { getSystemSwitch, setSystemSwitch } from "./systemState";

export interface OnboardingStep {
  key: string;
  title: string;
  body: string;
  order: number;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  { key: "welcome", order: 1, title: "Welcome to LARO",
    body: "LARO helps you understand your legal issue, find suitable lawyers, and prepare outreach. It never contacts anyone without your explicit approval." },
  { key: "privacy", order: 2, title: "Your data stays yours",
    body: "Your data is stored locally. You can export it or erase the live account from Settings → Privacy; recovery copies expire under the configured backup-retention policy." },
  { key: "create-case", order: 3, title: "Describe your case",
    body: "Create a case and describe the problem in plain words. LARO classifies it into legal areas automatically." },
  { key: "evidence", order: 4, title: "Add evidence",
    body: "Upload documents, or connect a source if configured. Each item keeps its origin and a content hash." },
  { key: "approve", order: 5, title: "You are always in control",
    body: "LARO prepares outreach drafts, but YOU review and approve each one. Nothing is sent automatically." },
  { key: "disclaimer", order: 6, title: "Not legal advice",
    body: "LARO assists and prepares; it is not a substitute for a qualified lawyer. Have important documents reviewed." },
];

export function listOnboardingSteps(): OnboardingStep[] {
  return [...ONBOARDING_STEPS].sort((a, b) => a.order - b.order);
}

function completeKey(userId: string): string {
  return `onboarding:complete:${userId}`;
}

export async function isOnboardingComplete(userId: string): Promise<boolean> {
  return getSystemSwitch(completeKey(userId));
}

export async function setOnboardingComplete(userId: string, complete: boolean): Promise<void> {
  await setSystemSwitch(completeKey(userId), complete);
}

export async function getOnboardingState(userId: string): Promise<{ complete: boolean; steps: OnboardingStep[] }> {
  return { complete: await isOnboardingComplete(userId), steps: listOnboardingSteps() };
}
