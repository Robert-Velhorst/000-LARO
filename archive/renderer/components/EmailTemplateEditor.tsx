import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Save, Eye, Code, Sparkles, RotateCcw } from 'lucide-react';

interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  type: 'initial' | 'followup1' | 'followup2' | 'custom';
}

const DEFAULT_TEMPLATES: EmailTemplate[] = [
  {
    id: 'initial',
    name: 'Initial Outreach',
    subject: 'Legal Case Referral: {{caseType}}',
    type: 'initial',
    body: `Geachte {{lawyerTitle}} {{lawyerName}},

Via LARO (Lawyer Automation & Referral Optimization) benaderen wij u namens een cliënt die juridische bijstand zoekt.

**Case Details:**
- Type: {{caseType}}
- Rechtsgebied(en): {{legalAreas}}
- Urgentie: {{urgency}}
- Locatie: {{clientCity}}

**Case Samenvatting:**
{{caseSummary}}

**Waarom u?**
Uw expertise in {{legalAreas}} en uw locatie ({{lawyerCity}}) maken u een geschikte match voor deze zaak.

**Volgende Stappen:**
Als u geïnteresseerd bent, kunt u reageren op deze email of contact opnemen via:
- Email: {{laroContactEmail}}
- Telefoon: {{laroContactPhone}}

Wij waarderen uw snelle reactie, aangezien de cliënt actief op zoek is naar juridische vertegenwoordiging.

Met vriendelijke groet,
LARO Matching System

---
*Deze email is verzonden via LARO's geautomatiseerde matching systeem. U ontvangt deze email omdat uw profiel overeenkomt met de behoeften van de cliënt.*`,
  },
  {
    id: 'followup1',
    name: 'First Follow-up (Day 3)',
    subject: 'Re: Legal Case Referral: {{caseType}}',
    type: 'followup1',
    body: `Geachte {{lawyerTitle}} {{lawyerName}},

We hebben u 3 dagen geleden benaderd over een juridische zaak die goed bij uw expertise past.

**Case Herinnering:**
- Type: {{caseType}}
- Rechtsgebied(en): {{legalAreas}}
- Urgentie: {{urgency}}

We begrijpen dat u het druk heeft, maar de cliënt is nog steeds op zoek naar juridische vertegenwoordiging.

**Bent u geïnteresseerd?**
Laat het ons weten door te reageren op deze email. Als u niet beschikbaar bent, geen probleem - we waarderen uw tijd.

Met vriendelijke groet,
LARO Matching System`,
  },
  {
    id: 'followup2',
    name: 'Second Follow-up (Day 7)',
    subject: 'Final Reminder: Legal Case Referral',
    type: 'followup2',
    body: `Geachte {{lawyerTitle}} {{lawyerName}},

Dit is onze laatste herinnering over de juridische zaak die we 7 dagen geleden met u deelden.

**Case:** {{caseType}} in {{clientCity}}

Als we binnen 48 uur geen reactie ontvangen, gaan we ervan uit dat u momenteel niet beschikbaar bent en zullen we andere advocaten benaderen.

Bedankt voor uw aandacht.

Met vriendelijke groet,
LARO Matching System`,
  },
];

const AVAILABLE_VARIABLES = [
  { key: '{{lawyerName}}', description: 'Lawyer full name' },
  { key: '{{lawyerTitle}}', description: 'Lawyer title (mr./mevrouw mr.)' },
  { key: '{{lawyerCity}}', description: 'Lawyer city' },
  { key: '{{caseType}}', description: 'Type of legal case' },
  { key: '{{caseSummary}}', description: 'Case summary/description' },
  { key: '{{legalAreas}}', description: 'Legal areas (comma-separated)' },
  { key: '{{urgency}}', description: 'Case urgency (Low/Medium/High)' },
  { key: '{{clientCity}}', description: 'Client city' },
  { key: '{{clientName}}', description: 'Client name' },
  { key: '{{laroContactEmail}}', description: 'LARO contact email' },
  { key: '{{laroContactPhone}}', description: 'LARO contact phone' },
];

export function EmailTemplateEditor() {
  const [templates, setTemplates] = useState<EmailTemplate[]>(DEFAULT_TEMPLATES);
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate>(templates[0]);
  const [editMode, setEditMode] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);

  const handleSave = () => {
    const updatedTemplates = templates.map(t =>
      t.id === selectedTemplate.id ? selectedTemplate : t
    );
    setTemplates(updatedTemplates);
    setEditMode(false);
    toast.success('Template saved successfully');
  };

  const handleReset = () => {
    const defaultTemplate = DEFAULT_TEMPLATES.find(t => t.id === selectedTemplate.id);
    if (defaultTemplate) {
      setSelectedTemplate({ ...defaultTemplate });
      toast.info('Template reset to default');
    }
  };

  const insertVariable = (variable: string) => {
    setSelectedTemplate({
      ...selectedTemplate,
      body: selectedTemplate.body + variable,
    });
  };

  const renderPreview = () => {
    // Replace variables with sample data for preview
    let preview = selectedTemplate.body
      .replace(/{{lawyerName}}/g, 'Jan de Vries')
      .replace(/{{lawyerTitle}}/g, 'mr.')
      .replace(/{{lawyerCity}}/g, 'Amsterdam')
      .replace(/{{caseType}}/g, 'Arbeidsrecht - Ontslag')
      .replace(/{{caseSummary}}/g, 'Cliënt is onterecht ontslagen na 5 jaar dienstverband. Werkgever heeft geen geldige reden gegeven.')
      .replace(/{{legalAreas}}/g, 'Arbeidsrecht, Ontslagrecht')
      .replace(/{{urgency}}/g, 'High')
      .replace(/{{clientCity}}/g, 'Rotterdam')
      .replace(/{{clientName}}/g, 'Pieter Janssen')
      .replace(/{{laroContactEmail}}/g, 'contact@laro.nl')
      .replace(/{{laroContactPhone}}/g, '+31 20 123 4567');

    return preview.split('\n').map((line, i) => (
      <p key={i} className={line.trim() === '' ? 'h-4' : ''}>
        {line}
      </p>
    ));
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-400" />
            Email Template Editor
          </CardTitle>
          <CardDescription>
            Customize automated outreach emails sent to lawyers
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={selectedTemplate.id} onValueChange={(id) => {
            const template = templates.find(t => t.id === id);
            if (template) setSelectedTemplate({ ...template });
            setEditMode(false);
            setPreviewMode(false);
          }}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="initial">Initial Outreach</TabsTrigger>
              <TabsTrigger value="followup1">Follow-up 1 (Day 3)</TabsTrigger>
              <TabsTrigger value="followup2">Follow-up 2 (Day 7)</TabsTrigger>
            </TabsList>

            <TabsContent value={selectedTemplate.id} className="space-y-4 mt-6">
              {/* Template Name */}
              <div>
                <Label>Template Name</Label>
                <Input
                  value={selectedTemplate.name}
                  onChange={(e) => setSelectedTemplate({ ...selectedTemplate, name: e.target.value })}
                  disabled={!editMode}
                />
              </div>

              {/* Subject Line */}
              <div>
                <Label>Subject Line</Label>
                <Input
                  value={selectedTemplate.subject}
                  onChange={(e) => setSelectedTemplate({ ...selectedTemplate, subject: e.target.value })}
                  disabled={!editMode}
                  placeholder="Email subject..."
                />
              </div>

              {/* Body Editor */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Email Body</Label>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={previewMode ? 'default' : 'outline'}
                      onClick={() => setPreviewMode(!previewMode)}
                    >
                      <Eye className="w-4 h-4 mr-2" />
                      {previewMode ? 'Hide Preview' : 'Preview'}
                    </Button>
                    {editMode && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleReset}
                      >
                        <RotateCcw className="w-4 h-4 mr-2" />
                        Reset
                      </Button>
                    )}
                  </div>
                </div>

                {previewMode ? (
                  <Card className="p-4 bg-card/50 border-2 border-dashed">
                    <div className="text-sm whitespace-pre-wrap">
                      {renderPreview()}
                    </div>
                  </Card>
                ) : (
                  <Textarea
                    value={selectedTemplate.body}
                    onChange={(e) => setSelectedTemplate({ ...selectedTemplate, body: e.target.value })}
                    disabled={!editMode}
                    rows={20}
                    className="font-mono text-sm"
                    placeholder="Email body..."
                  />
                )}
              </div>

              {/* Available Variables */}
              {editMode && (
                <Card className="bg-muted/30">
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Code className="w-4 h-4" />
                      Available Variables
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Click to insert into email body
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {AVAILABLE_VARIABLES.map((variable) => (
                        <Badge
                          key={variable.key}
                          variant="secondary"
                          className="cursor-pointer hover:bg-primary/20"
                          onClick={() => insertVariable(variable.key)}
                          title={variable.description}
                        >
                          {variable.key}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Action Buttons */}
              <div className="flex gap-2 pt-4">
                {editMode ? (
                  <>
                    <Button onClick={handleSave} className="bg-green-500 hover:bg-green-600">
                      <Save className="w-4 h-4 mr-2" />
                      Save Template
                    </Button>
                    <Button onClick={() => setEditMode(false)} variant="outline">
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => setEditMode(true)}>
                    Edit Template
                  </Button>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

