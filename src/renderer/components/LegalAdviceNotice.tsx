import { Scale } from "lucide-react";
import { useI18n } from "@/contexts/I18nContext";

export function LegalAdviceNotice() {
  const { t } = useI18n();
  return (
    <aside
      role="note"
      aria-label={t("legal.noticeLabel")}
      className="mt-8 flex items-start gap-2 border-t border-border/60 pt-3 text-xs leading-5 text-muted-foreground"
    >
      <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <p>
        <span className="font-medium text-foreground">{t("legal.noticeTitle")}</span>{" "}
        {t("legal.noticeBody")}
      </p>
    </aside>
  );
}
