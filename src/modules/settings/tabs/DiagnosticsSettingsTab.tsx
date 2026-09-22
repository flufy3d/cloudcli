import { useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import {
  clearStartupDiagnosticsHistory,
  downloadStartupDiagnosticsReport,
} from '@/shared/diagnostics/startupDiagnostics';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';

/** Rendered by Settings to export privacy-scoped startup and PWA diagnostics for performance analysis. */
export default function DiagnosticsSettingsTab() {
  const { t } = useTranslation('settings');
  // Tracks the export request so duplicate taps do not create ambiguous downloads.
  const [isExporting, setIsExporting] = useState(false);
  // Gives the user an explicit result because mobile browsers can hide a failed download.
  const [result, setResult] = useState<'success' | 'error' | null>(null);

  const handleExport = async () => {
    setIsExporting(true);
    setResult(null);
    try {
      await downloadStartupDiagnosticsReport();
      setResult('success');
    } catch (error) {
      console.error('Failed to export startup diagnostics', error);
      setResult('error');
    } finally {
      setIsExporting(false);
    }
  };

  const handleClear = () => {
    clearStartupDiagnosticsHistory();
    setResult(null);
  };

  return (
    <div className="space-y-8">
      <SettingsSection title={t('diagnostics.title')} description={t('diagnostics.description')}>
        <SettingsCard className="space-y-4 p-4">
          <p className="text-sm text-muted-foreground">{t('diagnostics.privacy')}</p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void handleExport()} disabled={isExporting}>
              <Download className="mr-2 h-4 w-4" />
              {isExporting ? t('diagnostics.exporting') : t('diagnostics.export')}
            </Button>
            <Button variant="outline" onClick={handleClear} disabled={isExporting}>
              <Trash2 className="mr-2 h-4 w-4" />
              {t('diagnostics.clearHistory')}
            </Button>
          </div>
          {result === 'success' && <p className="text-sm text-green-600 dark:text-green-400">{t('diagnostics.exportSuccess')}</p>}
          {result === 'error' && <p className="text-sm text-destructive">{t('diagnostics.exportFailed')}</p>}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
