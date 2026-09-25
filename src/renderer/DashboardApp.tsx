/**
 * Full LARO dashboard for the packaged desktop and supported server renderer.
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Router, Route, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useAuth } from "@/_core/hooks/useAuth";
import AuthPage from "@/components/AuthPage";
import { DashboardSkeleton } from "@/components/SkeletonLoaders";
import { WebSocketProvider } from "@/contexts/WebSocketContext";
import { useI18n } from "@/contexts/I18nContext";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import SkipNavigation from "@/components/SkipNavigation";
import DashboardLayout from "@/components/DashboardLayout";
import WorkspaceIdentity from "@/components/WorkspaceIdentity";
import OnboardingFlow from "@/components/OnboardingFlow";

const Home = lazy(() => import("@/components/Home"));
const Cases = lazy(() => import("@/components/Cases"));
const Evidence = lazy(() => import("@/components/Evidence"));
const Lawyers = lazy(() => import("@/components/Lawyers"));
const LawyerProfile = lazy(() => import("@/components/LawyerProfile"));
const OutreachAnalytics = lazy(() => import("@/components/OutreachAnalytics"));
const Help = lazy(() => import("@/components/Help"));
const Settings = lazy(() => import("@/components/Settings"));
const Privacy = lazy(() => import("@/components/Privacy"));
const Admin = lazy(() => import("@/components/Admin"));
const Messages = lazy(() => import("@/components/Messages"));

const fileProtocol =
  typeof window !== "undefined" && window.location.protocol === "file:";

export default function DashboardApp() {
  const { user, loading, error, refresh } = useAuth();
  const queryClient = useQueryClient();
  const { t, locale } = useI18n();
  const [sessionInvalidated, setSessionInvalidated] = useState(false);
  const [sessionCheckFailed, setSessionCheckFailed] = useState(false);
  const refreshRef = useRef(refresh);
  const sessionGeneration = useRef(0);
  refreshRef.current = refresh;

  useEffect(() => {
    const isSessionQuery = (query: { queryKey: readonly unknown[] }) => {
      const path = query.queryKey[0];
      return Array.isArray(path) && path[0] === "auth" && path[1] === "me";
    };
    const clearPreviousAccountData = async () => {
      const protectedQuery = (query: { queryKey: readonly unknown[] }) => !isSessionQuery(query);
      await queryClient.cancelQueries({ predicate: protectedQuery });
      queryClient.removeQueries({ predicate: protectedQuery });
      queryClient.getMutationCache().clear();
    };
    const onSessionChanged = () => {
      const generation = ++sessionGeneration.current;
      setSessionInvalidated(true);
      setSessionCheckFailed(false);
      void clearPreviousAccountData().then(() => refreshRef.current()).then(async (result) => {
        if (sessionGeneration.current !== generation) return;
        await clearPreviousAccountData();
        if (result.isError) setSessionCheckFailed(true);
        else setSessionInvalidated(false);
      }).catch(() => {
        if (sessionGeneration.current === generation) setSessionCheckFailed(true);
      });
    };
    window.addEventListener('laro:scanner-session-changed', onSessionChanged);
    return () => window.removeEventListener('laro:scanner-session-changed', onSessionChanged);
  }, [queryClient]);

  if (sessionInvalidated && sessionCheckFailed) {
    return <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-md border border-border bg-card p-6 text-center">
        <AlertCircle className="mx-auto h-8 w-8 text-destructive" aria-hidden="true" />
        <h1 className="mt-4 text-lg font-semibold">{t("auth.connectionError")}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("auth.connectionErrorDetail")}</p>
        <Button className="mt-5" onClick={() => window.location.reload()}>
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />{t("common.retry")}
        </Button>
      </section>
    </main>;
  }

  if (loading || sessionInvalidated) {
    return <DashboardSkeleton />;
  }

  if (error && !user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-md border border-border bg-card p-6 text-center">
          <AlertCircle className="mx-auto h-8 w-8 text-destructive" aria-hidden="true" />
          <h1 className="mt-4 text-lg font-semibold">{t("auth.connectionError")}</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("auth.connectionErrorDetail")}</p>
          {['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname) && (
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{locale === 'nl'
              ? 'Controleer of LARO op deze computer draait. Zodra de server weer bereikbaar is, wordt de verbinding automatisch hersteld.'
              : 'Check that LARO is running on this computer. The connection will recover automatically when the server is reachable again.'}</p>
          )}
          <Button className="mt-5" onClick={() => void refresh()}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            {t("common.retry")}
          </Button>
        </section>
      </main>
    );
  }

  if (!user) {
    return <><WorkspaceIdentity /><AuthPage /></>;
  }

  return (
    <>
      <WorkspaceIdentity />
      <SkipNavigation />
      <WebSocketProvider>
        <Router {...(fileProtocol ? { hook: useHashLocation } : {})}>
          <OnboardingFlow key={`onboarding:${user.id}`} />
          <DashboardLayout key={`workspace:${user.id}`}>
          <Suspense fallback={<div role="status" className="py-12 text-center text-muted-foreground">{t("common.loading")}</div>}>
            <Switch>
              <Route path="/" component={Home} />
              <Route path="/cases" component={Cases} />
              <Route path="/evidence" component={Evidence} />
              <Route path="/lawyers/:id" component={LawyerProfile} />
              <Route path="/lawyers" component={Lawyers} />
              <Route path="/outreach" component={OutreachAnalytics} />
              <Route path="/help" component={Help} />

              <Route path="/settings" component={Settings} />
              <Route path="/email-settings" component={Settings} />
              <Route path="/email-preferences" component={Settings} />
              <Route path="/privacy" component={Privacy} />

              <Route path="/admin" component={Admin} />
              <Route path="/admin-analytics" component={Admin} />

              <Route path="/messages" component={Messages} />
              <Route path="/email" component={Messages} />
              <Route path="/analytics">
                <OutreachAnalytics />
              </Route>

              <Route>
                <div className="p-8 text-center text-muted-foreground">
                  <h1 className="text-2xl font-semibold text-foreground">{t("route.notFound")}</h1>
                  <p className="mt-2 text-sm">{t("route.notFoundHint")}</p>
                </div>
              </Route>
            </Switch>
          </Suspense>
          </DashboardLayout>
        </Router>
      </WebSocketProvider>
    </>
  );
}
