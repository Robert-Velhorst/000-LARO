import DashboardLayout from "@/components/DashboardLayout";
import CommunicationHub from "@/components/CommunicationHub";
import { PageHeading } from "./WorkspaceUi";
import { useI18n } from "@/contexts/I18nContext";
import { useSearchParams } from "wouter";
import SearchResultSelection from "./SearchResultSelection";

export default function Messages() {
  const { locale } = useI18n();
  const [params, setParams] = useSearchParams();
  const communicationId = params.get("communication");
  const dismissSearchResult = () => setParams(previous => {
    const next = new URLSearchParams(previous);
    next.delete("communication");
    return next;
  });
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeading title={locale === "nl" ? "Dossiernotities" : "Case Notes"} />

        {communicationId && <SearchResultSelection type="communication" id={communicationId} onDismiss={dismissSearchResult} />}
        <CommunicationHub />
      </div>
    </DashboardLayout>
  );
}
