import { useI18n } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";

export function LanguageSelector({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className={cn("space-y-1", className)}>
      {!compact ? <span className="text-xs font-medium text-muted-foreground">{t("language.label")}</span> : null}
      <div
        role="group"
        aria-label={t("language.label")}
        className="grid grid-cols-2 overflow-hidden rounded-md border border-border/70 bg-background/50 p-0.5"
      >
        {(["nl", "en"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={locale === value}
            title={value === "nl" ? t("language.dutch") : t("language.english")}
            onClick={() => setLocale(value)}
            className={cn(
              "min-h-7 rounded px-2 text-xs font-semibold uppercase transition-colors",
              locale === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {value}
          </button>
        ))}
      </div>
    </div>
  );
}
