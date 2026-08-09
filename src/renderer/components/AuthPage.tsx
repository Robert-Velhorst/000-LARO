import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Lock, Mail, User, ArrowRight, ShieldCheck, KeyRound } from "lucide-react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { useI18n } from "@/contexts/I18nContext";
import type { TranslationKey } from "../../../shared/i18n";

type AuthMode = "signin" | "signup" | "forgot" | "reset";

export default function AuthPage() {
  const { t } = useI18n();
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const utils = trpc.useUtils();
  const loginMutation = trpc.auth.login.useMutation();
  const signupMutation = trpc.auth.signup.useMutation();
  const requestResetMutation = trpc.auth.requestPasswordReset.useMutation();
  const resetPasswordMutation = trpc.auth.resetPassword.useMutation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (mode === "signin") {
        await loginMutation.mutateAsync({ email, password });
        toast.success(t("auth.welcomeBack"));
        await utils.auth.me.invalidate();
      } else if (mode === "signup") {
        await signupMutation.mutateAsync({ email, password, name });
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
      toast.error(error.message || t("auth.genericError"));
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
    <div className="relative min-h-screen bg-black flex items-center justify-center p-4">
      <LanguageSelector compact className="absolute right-4 top-4 w-24" />
      <div className="w-full max-w-md animate-in fade-in zoom-in duration-500">
        {/* Brand Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-4 mb-2">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 shadow-2xl shadow-primary/10">
              <ShieldCheck className="w-6 h-6 text-primary" />
            </div>
            <h1 className="text-4xl font-bold tracking-tight text-white uppercase letter-spacing-widest">LARO</h1>
          </div>
          <p className="text-muted-foreground">{t("app.tagline")}</p>
        </div>

        <Card className="border-border/50 bg-card/50 backdrop-blur-xl shadow-2xl">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl font-bold">{t(titleKeys[mode])}</CardTitle>
            <CardDescription>{t(descriptionKeys[mode])}</CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
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
                      className="pl-10 h-12 bg-background/50 border-border/50 focus:border-primary/50"
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
                    className="pl-10 h-12 bg-background/50 border-border/50 focus:border-primary/50"
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
                      className="pl-10 h-12 tracking-[0.5em] bg-background/50 border-border/50 focus:border-primary/50"
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
                      placeholder="••••••••"
                      type="password"
                      autoComplete={mode === "signup" ? "new-password" : "current-password"}
                      className="pl-10 h-12 bg-background/50 border-border/50 focus:border-primary/50"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
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
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      className="pl-10 h-12 bg-background/50 border-border/50 focus:border-primary/50"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                    />
                  </div>
                </div>
              )}

              {mode === "signin" && (
                <div className="text-right">
                  <button
                    type="button"
                    onClick={() => setMode("forgot")}
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
                className="w-full h-12 text-base font-semibold transition-all hover:scale-[1.02] active:scale-[0.98]"
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
                {(mode === "signin" || mode === "signup") && (
                  <button
                    type="button"
                    onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
                    className="text-sm text-muted-foreground hover:text-primary transition-colors underline-offset-4 hover:underline"
                  >
                    {mode === "signin"
                      ? t("auth.noAccount")
                      : t("auth.hasAccount")}
                  </button>
                )}

                {mode === "reset" && (
                  <button
                    type="button"
                    onClick={() => setMode("forgot")}
                    className="block w-full text-sm text-muted-foreground hover:text-primary transition-colors underline-offset-4 hover:underline"
                  >
                    {t("auth.resendCode")}
                  </button>
                )}

                {(mode === "forgot" || mode === "reset") && (
                  <button
                    type="button"
                    onClick={() => setMode("signin")}
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
    </div>
  );
}
