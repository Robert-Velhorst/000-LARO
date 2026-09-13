import DashboardLayout from "@/components/DashboardLayout";
import CommunicationHub from "@/components/CommunicationHub";
import { PageHeading } from "./WorkspaceUi";
import { useI18n } from "@/contexts/I18nContext";

export default function Messages() {
  const { locale } = useI18n();
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeading title={locale === "nl" ? "Dossiernotities" : "Case Notes"} />
        
        <CommunicationHub />
      </div>
    </DashboardLayout>
  );
}

