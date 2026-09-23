import { useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { Button } from '@/shared/ui';
import { downloadDiagnosticsReport } from '@/shared/diagnostics/diagnosticsReport';
import { resetRecordedFrames } from '@/shared/diagnostics/frameRecorder';
import { clearStartupDiagnosticsHistory } from '@/shared/diagnostics/startupDiagnostics';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';

/**
 * Rendered by Settings to export one diagnostics file covering how the app
 * started, what the websocket carried, and how the server says recent runs
 * ended — the three sides of "it was slow" and "it disconnected".
 */
export default function DiagnosticsSettingsTab() {
  const { t } = useTranslation('settings');
  // Tracks the export request so duplicate taps do not create ambiguous downloads.
  const [isExporting, setIsExporting] = useState(false);
  // Gives the user an explicit result because mobile browsers can hide a failed download.
  const [result, setResult] = useState<'success' | 'error' | 'cleared' | null>(null);

  const handleExport = async () => {
    setIsExporting(true);
    setResult(null);
    try {
      await downloadDiagnosticsReport(null);
      setResult('success');
    } catch (error) {
      console.error('Failed to export diagnostics', error);
      setResult('error');
    } finally {
      setIsExporting(false);
    }
  };

  // Clears all three sources at once, so "start a clean capture before
  // reproducing the problem" is a single action rather than a checklist.
  const handleClear = async () => {
    resetRecordedFrames();
    clearStartupDiagnosticsHistory();
    try {
      await api.diagnostics.clearRuns();
    } catch (error) {
      console.error('Failed to clear the server run log', error);
    }
    setResult('cleared');
  };

  return (
    <div className="space-y-8">
      <SettingsSection title={t('diagnostics.title')} description={t('diagnostics.description')}>
        <SettingsCard className="space-y-4 p-4">
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li>{t('diagnostics.includesStartup')}</li>
            <li>{t('diagnostics.includesFrames')}</li>
            <li>{t('diagnostics.includesRuns')}</li>
          </ul>
          <p className="text-sm text-muted-foreground">{t('diagnostics.privacy')}</p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void handleExport()} disabled={isExporting}>
              <Download className="mr-2 h-4 w-4" />
              {isExporting ? t('diagnostics.exporting') : t('diagnostics.export')}
            </Button>
            <Button variant="outline" onClick={() => void handleClear()} disabled={isExporting}>
              <Trash2 className="mr-2 h-4 w-4" />
              {t('diagnostics.clearHistory')}
            </Button>
          </div>
          {result === 'success' && <p className="text-sm text-green-600 dark:text-green-400">{t('diagnostics.exportSuccess')}</p>}
          {result === 'cleared' && <p className="text-sm text-muted-foreground">{t('diagnostics.clearedNotice')}</p>}
          {result === 'error' && <p className="text-sm text-destructive">{t('diagnostics.exportFailed')}</p>}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
