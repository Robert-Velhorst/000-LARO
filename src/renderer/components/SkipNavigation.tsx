import { useI18n } from "@/contexts/I18nContext";

/**
 * Skip Navigation Component
 * 
 * Allows keyboard users to skip directly to main content,
 * bypassing navigation menus. WCAG 2.1 Level A requirement.
 */

export default function SkipNavigation() {
  const { t } = useI18n();

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-orange-500 focus:px-4 focus:py-2 focus:text-slate-950 focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-orange-300 focus:ring-offset-2 focus:ring-offset-background"
      >
        {t("nav.skipToContent")}
      </a>
      {/* ARIA live region for screen reader announcements */}
      <div
        id="aria-live-region"
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />
    </>
  );
}

