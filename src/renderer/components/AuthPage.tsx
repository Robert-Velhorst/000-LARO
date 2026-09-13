import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Lock, Mail, User, ArrowRight, Eye, EyeOff, KeyRound } from "lucide-react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { useI18n } from "@/contexts/I18nContext";
import type { TranslationKey } from "../../../shared/i18n";

import { APP_LOGO } from "@/const";

type AuthMode = "signin" | "signup" | "forgot" | "reset";

export default function AuthPage() {
  const { t, locale } = useI18n();
  const [testTicket] = useState(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const ticket = params.get('local-test');
    return ticket;
  });
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const changeMode = (value: AuthMode) => {
    if (loading) return;
    setMode(value);
    setFormError("");
    setShowPassword(false);
  };

  const utils = trpc.useUtils();
  const loginMutation = trpc.auth.login.useMutation();
  const signupMutation = trpc.auth.signup.useMutation();
  const enrollment = trpc.auth.enrollment.useQuery(undefined, { staleTime: 0 });
  const requestResetMutation = trpc.auth.requestPasswordReset.useMutation();
  const resetPasswordMutation = trpc.auth.resetPassword.useMutation();
  const localTestMutation = trpc.auth.localTestAccess.useMutation();
  const openLocalTest = async () => {
    if (!testTicket || loading) return;
    setLoading(true);
    setFormError('');
    try {
      await localTestMutation.mutateAsync({ ticket: testTicket });
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      await utils.auth.me.invalidate();
    } catch (error: any) {
      setFormError(error.message || t('auth.genericError'));
    } finally { setLoading(false); }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setFormError("");

    try {
      if (mode === "signin") {
        await loginMutation.mutateAsync({ email, password });
        toast.success(t("auth.welcomeBack"));
        await utils.auth.me.invalidate();
      } else if (mode === "signup") {
        await signupMutation.mutateAsync({ email, password, name, bootstrapToken: setupCode || undefined });
        setSetupCode("");
        toast.success(t("auth.accountCreated"));
        await utils.auth.me.invalidate();
      } else if (mode === "forgot") {
        await requestResetMutation.mutateAsync({ email });
        toast.success(t("auth.resetRequested"));
        setMode("reset");
      } else if (mode === "reset") {
        await resetPasswordMutation.mutateAsync({ email, code, newPassword });
        toast.success(t("auth.resetComplete"));
        setPassword("");
        setCode("");
        setNewPassword("");
        setMode("signin");
      }
    } catch (error: any) {
      setFormError(error.message || t("auth.genericError"));
    } finally {
      setLoading(false);
    }
  };

  const titleKeys: Record<AuthMode, TranslationKey> = {
    signin: "auth.signIn",
    signup: "auth.signUp",
    forgot: "auth.resetPassword",
    reset: "auth.enterResetCode",
  };
  const descriptionKeys: Record<AuthMode, TranslationKey> = {
    signin: "auth.signInDescription",
    signup: "auth.signUpDescription",
    forgot: "auth.forgotDescription",
    reset: "auth.resetDescription",
  };
  const submitKeys: Record<AuthMode, TranslationKey> = {
    signin: "auth.signIn",
    signup: "auth.submitSignUp",
    forgot: "auth.sendResetCode",
    reset: "auth.resetPassword",
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-background px-4 py-20">
      <LanguageSelector compact className="absolute right-4 top-4 w-24" />
      <div className="w-full max-w-md">
        {/* Brand Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-4 mb-2">
            <img src={APP_LOGO} alt="" className="h-12 w-12 rounded-md" />
            <h1 className="text-3xl font-semibold text-foreground">LARO</h1>
          </div>
          <p className="text-muted-foreground">{t("app.tagline")}</p>
        </div>

        <Card className="border-border bg-card shadow-none">
          <CardHeader className="space-y-1">
            <CardTitle className="text-xl font-semibold">{t(titleKeys[mode])}</CardTitle>
            <CardDescription>{t(descriptionKeys[mode])}</CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              {mode === "signup" && enrollment.data?.requiresSetupCode && (
                <div className="space-y-2">
                  <Label htmlFor="setup-code">{t("auth.setupCode")}</Label>
                  <Input
                    id="setup-code"
                    type="password"
                    autoComplete="off"
                    value={setupCode}
                    onChange={(e) => setSetupCode(e.target.value)}
                    minLength={32}
                    maxLength={256}
                    required
                    aria-describedby="setup-code-help"
                  />
                  <p id="setup-code-help" className="text-sm text-muted-foreground">{t("auth.setupCodeHelp")}</p>
                </div>
              )}
              {formError && <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">{formError}</p>}
              {testTicket && mode === 'signin' && <div className="space-y-2 border-b border-border pb-4">
                <Button type="button" className="w-full" disabled={loading} onClick={() => void openLocalTest()}>
                  <KeyRound className="mr-2 h-4 w-4" />{locale === 'nl' ? 'Doorgaan zonder wachtwoord' : 'Continue without password'}
                </Button>
                <p className="text-sm text-muted-foreground">{locale === 'nl'
                  ? 'Lokale testsessie van 1 uur. Je opent je echte dossiers; wijzigingen worden opgeslagen.'
                  : 'Local test session for 1 hour. You are opening real cases; changes will be saved.'}</p>
              </div>}
              {mode === "signup" && (
                <div className="space-y-2">
                  <Label htmlFor="name">{t("auth.fullName")}</Label>
                  <div className="relative">
                    <User className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="name"
                      placeholder="John Doe"
                      type="text"
                      autoComplete="name"
                      className="h-11 bg-background pl-10 pr-12"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                    />
                  </div>
                </div>
              )}

              {/* Email — shown for every mode except the final reset step,
                  where it's locked to the address the code was sent to. */}
              <div className="space-y-2">
                <Label htmlFor="email">{t("auth.email")}</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="email"
                    placeholder="name@example.com"
                    type="email"
                    autoComplete="email"
                    className="h-11 bg-background pl-10 pr-12"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={mode === "reset"}
                  />
                </div>
              </div>

              {mode === "reset" && (
                <div className="space-y-2">
                  <Label htmlFor="code">{t("auth.resetCode")}</Label>
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="code"
                      placeholder="123456"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      className="h-11 bg-background pl-10"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                      required
                    />
                  </div>
                </div>
              )}

              {(mode === "signin" || mode === "signup") && (
                <div className="space-y-2">
                  <Label htmlFor="password">{t("auth.password")}</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="password"
                      minLength={mode === "signup" ? 8 : undefined}
                      placeholder="••••••••"
                      type={showPassword ? "text" : "password"}
                      autoComplete={mode === "signup" ? "new-password" : "current-password"}
                      className="h-11 bg-background pl-10 pr-12"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                    <Button type="button" size="icon" variant="ghost" className="absolute right-1 top-1 h-9 w-9"
                      aria-label={showPassword ? (locale === "nl" ? "Wachtwoord verbergen" : "Hide password") : (locale === "nl" ? "Wachtwoord tonen" : "Show password")}
                      aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              )}

              {mode === "reset" && (
                <div className="space-y-2">
                  <Label htmlFor="newPassword">{t("auth.newPassword")}</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="newPassword"
                      placeholder={t("auth.passwordHint")}
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      minLength={8}
                      className="h-11 bg-background pl-10 pr-12"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                    />
                    <Button type="button" size="icon" variant="ghost" className="absolute right-1 top-1 h-9 w-9"
                      aria-label={showPassword ? (locale === "nl" ? "Wachtwoord verbergen" : "Hide password") : (locale === "nl" ? "Wachtwoord tonen" : "Show password")}
                      aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              )}

              {mode === "signin" && (
                <div className="text-right">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => changeMode("forgot")}
                    className="text-sm text-muted-foreground hover:text-primary transition-colors underline-offset-4 hover:underline"
                  >
                    {t("auth.forgotPassword")}
                  </button>
                </div>
              )}
            </CardContent>
            <CardFooter className="flex flex-col space-y-4 pt-4">
              <Button
                type="submit"
                className="h-11 w-full text-base font-semibold"
                disabled={loading}
              >
                {loading ? (
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    {t("auth.processing")}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    {t(submitKeys[mode])}
                    <ArrowRight className="w-4 h-4" />
                  </div>
                )}
              </Button>

              <div className="text-center space-y-2">
                {(mode === "signup" || (mode === "signin" && enrollment.data?.open)) && (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => changeMode(mode === "signin" ? "signup" : "signin")}
                    className="text-sm text-muted-foreground hover:text-primary transition-colors underline-offset-4 hover:underline"
                  >
                    {mode === "signin"
                      ? t("auth.noAccount")
                      : t("auth.hasAccount")}
                  </button>
                )}
                {mode === "signin" && enrollment.data?.open === false && (
                  <p className="text-sm text-muted-foreground">{t("auth.enrollmentClosed")}</p>
                )}

                {mode === "reset" && (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => changeMode("forgot")}
                    className="block w-full text-sm text-muted-foreground hover:text-primary transition-colors underline-offset-4 hover:underline"
                  >
                    {t("auth.resendCode")}
                  </button>
                )}

                {(mode === "forgot" || mode === "reset") && (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => changeMode("signin")}
                    className="block w-full text-sm text-muted-foreground hover:text-primary transition-colors underline-offset-4 hover:underline"
                  >
                    {t("auth.backToSignIn")}
                  </button>
                )}
              </div>
            </CardFooter>
          </form>
        </Card>
      </div>
    </main>
  );
}
